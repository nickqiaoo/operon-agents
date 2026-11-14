import type { ChatModel } from "../../llm/define-model.ts";
import type { LlmRequest } from "../../llm/model.ts";
import { completeWithRetry } from "../../llm/retry.ts";
import type { AssistantMessage, TextContent } from "../../protocol/index.ts";
import type { AutoApprovalInput, AutoApprovalVerdict, AutoApprover } from "../types.ts";
import { buildClassifierSystemPrompt, type ClassifierRules } from "./prompts.ts";
import { buildToolLookup, buildTranscriptText, projectToolCall, serializeProjectedCall } from "./transcript.ts";
import { parseXmlBlock, parseXmlCategory, parseXmlReason } from "./xml.ts";

export type TwoStageMode = "both" | "fast" | "thinking";

export type AutoApprovalOutcome =
  | "allow" // judge cleared the action — proceeds without a prompt
  | "block" // judge blocked — refused, the reason goes back to the model
  | "escalate" // judge not confident enough to allow — falls back to the human approval path
  | "no-relevance" // tool declared no security-relevant input (allowed)
  | "parse_failure" // model output unparseable — failed closed (escalate)
  | "error" // model/stream error — failed closed (escalate)
  | "aborted"; // signal aborted — failed closed (escalate)

/** Telemetry record emitted once per `classify` call. */
export interface AutoApprovalReport {
  readonly outcome: AutoApprovalOutcome;
  readonly toolName: string;
  readonly stage?: "fast" | "thinking" | "decision";
  readonly reason?: string;
  /** With `block`: the BLOCK rule the judge named. */
  readonly category?: string;
  readonly durationMs: number;
}

export interface LlmAutoApproverOptions {
  /** User allow/deny/environment sections injected into the classifier prompt. */
  readonly rules?: ClassifierRules;
  /** `both` (default): fast stage, escalating to thinking only on a block. `fast`/`thinking`: one stage. */
  readonly twoStageMode?: TwoStageMode;
  /** Classifier model. Defaults to the main-loop model carried on `ctx.model`. */
  readonly model?: ChatModel;
  /** Stage-1 (fast) output budget. Default 512. */
  readonly stage1MaxTokens?: number;
  /** Stage-2 (thinking) output budget. Default 4096. */
  readonly stage2MaxTokens?: number;
  /** Consecutive model failures before short-circuiting to escalate (skips the call). Default 3. */
  readonly maxConsecutiveErrors?: number;
  /** How long a tripped breaker holds before letting one probe call through. Default 30s. */
  readonly breakerProbeDelayMs?: number;
  /** Cap on the breaker's probe backoff, which doubles per failed probe. Default 5min. */
  readonly breakerMaxProbeDelayMs?: number;
  /** Telemetry sink. Invoked once per classify with the outcome. */
  readonly onOutcome?: (report: AutoApprovalReport) => void;
}

// Stage suffixes. In `both`, stage 1 is a cheap over-blocking screen that ignores user intent and
// ALLOW exceptions (anything it passes is clearly fine); stage 2 reasons first and applies them,
// which is where false positives are cleared. `fast` has no stage 2 to defer to, so its single
// pass must weigh user intent and exceptions itself — it gets the plain immediate-verdict suffix.
const XML_FAST_ONLY_SUFFIX =
  "\nErr on the side of blocking. Your ENTIRE response MUST begin with <block>. Do NOT output any analysis, reasoning, or commentary before <block>. No \"Looking at...\" or similar preamble.";
const XML_S1_SUFFIX =
  "\nErr on the side of blocking. Stage 1 does NOT apply user intent or ALLOW exceptions \u2014 stage 2 will handle those. Judge the action by its full effect \u2014 what it runs, sends, publishes, or enables \u2014 not its surface form. Block if ANY rule could apply. Your ENTIRE response MUST begin with <block>. Do NOT output any analysis, reasoning, or commentary before <block>. No \"Looking at...\" or similar preamble.";
const XML_S2_SUFFIX =
  "\nReview the classification process and follow it carefully, making sure you deny actions that should be blocked. As a reminder, explicit (not suggestive or implicit) user confirmation is required to override blocks. Use <thinking> before responding with <block>. Think longer on ambiguous or borderline actions; keep reasoning brief for clear-cut ones.";

const DEFAULT_STAGE1_MAX_TOKENS = 512;
const DEFAULT_STAGE2_MAX_TOKENS = 4096;
/** Distinct session rule sets whose assembled (~130KB) system prompts are kept. */
const MAX_CACHED_PROMPTS = 8;
/** A tool call is waiting on this verdict, so it gets seconds of retries, not minutes. */
const CLASSIFIER_RETRY_POLICY = { maxRetries: 5, maxDelayMs: 8_000 };

const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_BREAKER_PROBE_DELAY_MS = 30_000;
const DEFAULT_BREAKER_MAX_PROBE_DELAY_MS = 5 * 60_000;

const ALLOW: AutoApprovalVerdict = { decision: "allow" };

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * The `auto`-mode judge — a two-stage XML security classifier.
 *
 * For each would-prompt action the PermissionManager hands over, it builds a sanitized
 * transcript (user text + the agent's prior tool calls, projected) plus the action under review,
 * and asks the classifier whether to block. Stage 1 is a cheap fast pass that resolves the common
 * "allow" case in a few tokens; only a block escalates to the slower thinking stage.
 *
 * A block returns `block`: the manager refuses the call and hands the reason back to the model.
 * Fail-closed everywhere else: a stream error, abort, or unparseable response all return
 * `escalate`, so a judge that could not decide falls back to the human rather than allowing.
 */
export class LlmAutoApprover implements AutoApprover {
  private readonly options: LlmAutoApproverOptions;
  private systemPrompt: string | undefined;
  private readonly sessionPrompts = new Map<string, string>();
  private consecutiveErrors = 0;
  private lastErrorAt = 0;

  constructor(options: LlmAutoApproverOptions = {}) {
    this.options = options;
  }

  private system(rules: AutoApprovalInput["autoApproval"]): string {
    if (rules === undefined) {
      this.systemPrompt ??= buildClassifierSystemPrompt(this.options.rules);
      return this.systemPrompt;
    }
    const key = JSON.stringify([rules.allow, rules.softDeny, rules.hardDeny, rules.deny, rules.environment]);
    let prompt = this.sessionPrompts.get(key);
    if (prompt === undefined) {
      prompt = buildClassifierSystemPrompt(rules);
      if (this.sessionPrompts.size >= MAX_CACHED_PROMPTS) this.sessionPrompts.delete(this.sessionPrompts.keys().next().value!);
      this.sessionPrompts.set(key, prompt);
    }
    return prompt;
  }

  async classify(input: AutoApprovalInput): Promise<AutoApprovalVerdict> {
    const startedAt = Date.now();
    const toolName = input.ctx.toolCall.name;
    const report = (outcome: AutoApprovalOutcome, extra?: { stage?: "fast" | "thinking"; reason?: string; category?: string }): void => {
      this.options.onOutcome?.({ outcome, toolName, durationMs: Date.now() - startedAt, ...extra });
    };
    const escalate = (outcome: AutoApprovalOutcome, reason: string, stage?: "fast" | "thinking"): AutoApprovalVerdict => {
      report(outcome, { stage, reason });
      return { decision: "escalate", reason };
    };
    const blocked = (text: string, fallback: string, stage: "fast" | "thinking"): AutoApprovalVerdict => {
      const reason = parseXmlReason(text) ?? fallback;
      const category = parseXmlCategory(text) ?? undefined;
      report("block", { stage, reason, ...(category !== undefined ? { category } : {}) });
      return { decision: "block", reason, ...(category !== undefined ? { category } : {}) };
    };

    const lookup = buildToolLookup(input.tools);
    const action = projectToolCall(toolName, input.ctx.args, input.ctx.tool, lookup);
    if (action === "") {
      report("no-relevance");
      return { decision: "allow", reason: "Tool declares no security-relevant input" };
    }

    if (this.breakerHolding()) {
      return escalate("error", "Auto-approval judge repeatedly unavailable — asking for confirmation.");
    }

    const actionLine = serializeProjectedCall(toolName, action, input.ctx.toolCall.id);
    const transcript = buildTranscriptText(input.transcript, lookup, input.ctx.toolCall.id);
    const content = `<transcript>\n${transcript}${actionLine}</transcript>\n`;
    const model = this.options.model ?? input.ctx.model;
    const signal = input.ctx.signal;
    const mode = input.autoApproval?.twoStageMode ?? this.options.twoStageMode ?? "both";
    const system = this.system(input.autoApproval);

    try {
      if (mode !== "thinking") {
        const max = this.options.stage1MaxTokens ?? DEFAULT_STAGE1_MAX_TOKENS;
        const suffix = mode === "fast" ? XML_FAST_ONLY_SUFFIX : XML_S1_SUFFIX;
        const text = await this.runStage(model, content + suffix, max, signal, system);
        const block = parseXmlBlock(text);
        if (block === false) {
          report("allow", { stage: "fast" });
          return ALLOW;
        }
        if (mode === "fast") {
          if (block === null) return escalate("parse_failure", "Fast classifier response was unparseable.", "fast");
          return blocked(text, "Blocked by the fast classifier.", "fast");
        }
        // mode "both": a block (or unparseable) stage 1 escalates to the thinking stage.
      }

      const max = this.options.stage2MaxTokens ?? DEFAULT_STAGE2_MAX_TOKENS;
      const text = await this.runStage(model, content + XML_S2_SUFFIX, max, signal, system);
      const block = parseXmlBlock(text);
      if (block === null) return escalate("parse_failure", "Classifier response was unparseable.", "thinking");
      if (block === false) {
        report("allow", { stage: "thinking" });
        return ALLOW;
      }
      return blocked(text, "Blocked by the auto-approval judge.", "thinking");
    } catch (error) {
      if (signal.aborted) return escalate("aborted", "Auto-approval judge aborted — asking for confirmation.");
      this.consecutiveErrors += 1;
      this.lastErrorAt = Date.now();
      const reason = error instanceof Error ? error.message : String(error);
      return escalate("error", `Auto-approval judge unavailable (${reason}) — asking for confirmation.`);
    }
  }

  /**
   * Whether the tripped breaker is still holding this call back.
   *
   * Once the model has failed `maxConsecutiveErrors` times running, asking it again mostly buys
   * latency for an answer we expect to fail — so the breaker trips and `classify` escalates
   * without a call. Staying tripped forever would be a one-way door: the only line that clears
   * the breaker lives inside `runStage`, which a permanently-open breaker never reaches. A
   * transient outage would then silently demote `auto` to `manual` for the rest of the process,
   * long after the provider recovered, with a restart the only way out.
   *
   * So it half-opens instead: after a backoff, one call is let through to probe. The probe
   * succeeds and `runStage` clears the breaker; it fails and the breaker trips again with twice
   * the delay, up to the cap — the outage costs one call per backoff window rather than one per
   * tool call.
   */
  private breakerHolding(): boolean {
    const max = this.options.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
    if (this.consecutiveErrors < max) return false;
    const base = this.options.breakerProbeDelayMs ?? DEFAULT_BREAKER_PROBE_DELAY_MS;
    const cap = this.options.breakerMaxProbeDelayMs ?? DEFAULT_BREAKER_MAX_PROBE_DELAY_MS;
    // The failure that trips the breaker waits `base`; each failed probe after it waits twice
    // as long. Overflowing to Infinity at absurd error counts is fine — `min` pins it to `cap`.
    const delay = Math.min(base * 2 ** (this.consecutiveErrors - max), cap);
    return Date.now() - this.lastErrorAt < delay;
  }

  /** Run one classifier stage and return its text content. Throws on a stream error. */
  private async runStage(model: ChatModel, userText: string, maxTokens: number, signal: AbortSignal, system: string): Promise<string> {
    const request: LlmRequest = {
      systemPrompt: system,
      messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
      // No thinking, so tokens aren't spent reasoning. No temperature either: providers disagree
      // on what they accept (Mistral rejects 0 without top_p 1), and a request refused here
      // silently demotes `auto` to asking. cacheRetention enables prompt caching of the shared
      // system + transcript prefix across stages/calls.
      params: { maxTokens },
      providerOptions: { cacheRetention: "long" },
    };
    const message = await completeWithRetry(model, request, { signal }, CLASSIFIER_RETRY_POLICY);
    if (message.stopReason === "error") throw new Error(message.errorMessage ?? "classifier stream error");
    this.consecutiveErrors = 0; // the model responded — clear the breaker
    return textOf(message);
  }
}
