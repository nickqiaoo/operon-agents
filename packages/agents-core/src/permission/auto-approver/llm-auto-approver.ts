import type { ChatModel } from "../../llm/define-model.ts";
import type { LlmRequest } from "../../llm/model.ts";
import type { AssistantMessage, TextContent } from "../../protocol/index.ts";
import type { AutoApprovalInput, AutoApprovalVerdict, AutoApprover } from "../types.ts";
import { buildClassifierSystemPrompt, type ClassifierRules } from "./prompts.ts";
import { buildToolLookup, buildTranscriptText, projectToolCall } from "./transcript.ts";
import { parseXmlBlock, parseXmlReason } from "./xml.ts";

export type TwoStageMode = "both" | "fast" | "thinking";

export type AutoApprovalOutcome =
  | "allow" // judge cleared the action — proceeds without a prompt
  | "escalate" // judge blocked — falls back to the human approval path
  | "no-relevance" // tool declared no security-relevant input (allowed)
  | "parse_failure" // model output unparseable — failed closed (escalate)
  | "error" // model/stream error — failed closed (escalate)
  | "aborted"; // signal aborted — failed closed (escalate)

/** Telemetry record emitted once per `classify` call. */
export interface AutoApprovalReport {
  readonly outcome: AutoApprovalOutcome;
  readonly toolName: string;
  readonly stage?: "fast" | "thinking";
  readonly reason?: string;
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

// Stage suffixes. Stage 1 nudges an immediate verdict; stage 2 asks for
// chain-of-thought before the verdict to cut false positives.
const XML_S1_SUFFIX = "\nErr on the side of blocking. <block> immediately.";
const XML_S2_SUFFIX =
  "\nReview the classification process and follow it carefully, making sure you deny actions that should be blocked. As a reminder, explicit (not suggestive or implicit) user confirmation is required to override blocks. Use <thinking> before responding with <block>.";

const DEFAULT_STAGE1_MAX_TOKENS = 512;
const DEFAULT_STAGE2_MAX_TOKENS = 4096;
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
 * Fail-closed everywhere: a stream error, abort, or unparseable response all return `escalate`,
 * so uncertainty falls back to the human rather than silently allowing. `shouldBlock` maps to
 * `escalate` (not a hard block) because this framework always has a human fallback — the judge's
 * job is only deciding whether a human prompt can be skipped.
 */
export class LlmAutoApprover implements AutoApprover {
  private readonly options: LlmAutoApproverOptions;
  private systemPrompt: string | undefined;
  private consecutiveErrors = 0;
  private lastErrorAt = 0;

  constructor(options: LlmAutoApproverOptions = {}) {
    this.options = options;
  }

  private system(): string {
    this.systemPrompt ??= buildClassifierSystemPrompt(this.options.rules);
    return this.systemPrompt;
  }

  async classify(input: AutoApprovalInput): Promise<AutoApprovalVerdict> {
    const startedAt = Date.now();
    const toolName = input.ctx.toolCall.name;
    const report = (outcome: AutoApprovalOutcome, extra?: { stage?: "fast" | "thinking"; reason?: string }): void => {
      this.options.onOutcome?.({ outcome, toolName, durationMs: Date.now() - startedAt, ...extra });
    };
    const escalate = (outcome: AutoApprovalOutcome, reason: string, stage?: "fast" | "thinking"): AutoApprovalVerdict => {
      report(outcome, { stage, reason });
      return { decision: "escalate", reason };
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

    const actionLine = `${JSON.stringify({ [toolName]: action })}\n`;
    const transcript = buildTranscriptText(input.transcript, lookup, input.ctx.toolCall.id);
    const content = `<transcript>\n${transcript}${actionLine}</transcript>\n`;
    const model = this.options.model ?? input.ctx.model;
    const signal = input.ctx.signal;
    const mode = this.options.twoStageMode ?? "both";

    try {
      if (mode !== "thinking") {
        const max = this.options.stage1MaxTokens ?? DEFAULT_STAGE1_MAX_TOKENS;
        const text = await this.runStage(model, content + XML_S1_SUFFIX, max, signal);
        const block = parseXmlBlock(text);
        if (block === false) {
          report("allow", { stage: "fast" });
          return ALLOW;
        }
        if (mode === "fast") {
          if (block === null) return escalate("parse_failure", "Fast classifier response was unparseable.", "fast");
          return escalate("escalate", parseXmlReason(text) ?? "Blocked by fast classifier.", "fast");
        }
        // mode "both": a block (or unparseable) stage 1 escalates to the thinking stage.
      }

      const max = this.options.stage2MaxTokens ?? DEFAULT_STAGE2_MAX_TOKENS;
      const text = await this.runStage(model, content + XML_S2_SUFFIX, max, signal);
      const block = parseXmlBlock(text);
      if (block === null) return escalate("parse_failure", "Classifier response was unparseable.", "thinking");
      if (block === false) {
        report("allow", { stage: "thinking" });
        return ALLOW;
      }
      return escalate("escalate", parseXmlReason(text) ?? "Blocked by the auto-approval judge.", "thinking");
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
  private async runStage(model: ChatModel, userText: string, maxTokens: number, signal: AbortSignal): Promise<string> {
    const request: LlmRequest = {
      system: this.system(),
      messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
      // No thinking (so temperature applies and tokens aren't spent reasoning), temp 0 for
      // determinism (pi drops it for models that reject it). cacheRetention enables prompt
      // caching of the shared system + transcript prefix across stages/calls.
      params: { temperature: 0, maxTokens },
      providerOptions: { cacheRetention: "long" },
    };
    const message = await model.complete(request, { signal });
    if (message.stopReason === "error") throw new Error(message.errorMessage ?? "classifier stream error");
    this.consecutiveErrors = 0; // the model responded — clear the breaker
    return textOf(message);
  }
}
