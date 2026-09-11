// The two surfaces: what the bridge's calls become on each platform.
//
// Linear has a vocabulary for exactly this -- agent activities: thought, action, response,
// elicitation, error -- so each call is one activity, and a PR becomes an external link on the
// session. The Chat SDK adapter covers response (thread.post) and the typing thought; the rest
// goes straight to the Linear client the adapter exposes.
//
// GitHub has comments. Thoughts and tool calls accumulate and ride along inside the next comment
// as a collapsed trace, so a review thread gets one reply per turn, not one per step.

import type { LinearClient } from "@linear/sdk";
import type { Surface, ToolTrace } from "./bridge.ts";

/** The slice of a Chat SDK thread the surfaces use. */
export interface PostableThread {
  post(markdown: string): Promise<unknown>;
  startTyping?(status?: string): Promise<void>;
}

function traceLine(call: ToolTrace): string {
  const mark = call.status === "running" ? "…" : call.status === "error" ? "✗" : "✓";
  return `${mark} ${call.name}${call.hint ? `: ${call.hint}` : ""}`;
}

export class LinearSurface implements Surface {
  constructor(
    private readonly thread: PostableThread,
    private readonly linear: LinearClient,
    private readonly agentSessionId: string,
  ) {}

  private activity(content: Record<string, unknown>, ephemeral = false): Promise<unknown> {
    return this.linear.createAgentActivity({ agentSessionId: this.agentSessionId, content, ...(ephemeral ? { ephemeral } : {}) });
  }

  async ack(status: string): Promise<void> {
    if (this.thread.startTyping) await this.thread.startTyping(status);
    else await this.activity({ type: "thought", body: status }, true);
  }

  async thought(markdown: string): Promise<void> {
    await this.activity({ type: "thought", body: markdown });
  }

  async action(call: ToolTrace): Promise<void> {
    const parameter = call.hint;
    if (call.status === "running") {
      // Ephemeral: replaced by the next activity, so a long command shows as in progress
      // without leaving a permanent "started" line behind the finished one.
      await this.activity({ type: "action", action: call.name, parameter }, true);
      return;
    }
    const result = call.result ? (call.status === "error" ? `✗ ${call.result}` : call.result) : call.status === "error" ? "✗ failed" : "done";
    await this.activity({ type: "action", action: call.name, parameter, result });
  }

  async respond(markdown: string): Promise<void> {
    await this.thread.post(markdown);
  }

  async ask(markdown: string): Promise<void> {
    await this.activity({ type: "elicitation", body: markdown });
  }

  async error(markdown: string): Promise<void> {
    await this.activity({ type: "error", body: markdown });
  }

  async link(label: string, url: string): Promise<void> {
    await this.linear.updateAgentSession(this.agentSessionId, { addedExternalUrls: [{ label, url }] });
  }
}

export class GitHubSurface implements Surface {
  private thoughts: string[] = [];
  private calls = new Map<string, ToolTrace>();

  constructor(private readonly thread: PostableThread) {}

  private flush(body: string): Promise<unknown> {
    const calls = [...this.calls.values()];
    const thoughts = this.thoughts;
    this.calls = new Map();
    this.thoughts = [];
    if (calls.length === 0 && thoughts.length === 0) return this.thread.post(body);
    const trace = [
      ...thoughts.map((t) => `> ${t.replace(/\n/g, "\n> ")}`),
      ...(calls.length > 0 ? ["```", ...calls.map(traceLine), "```"] : []),
    ].join("\n\n");
    const summary = `${calls.length} tool call${calls.length === 1 ? "" : "s"}`;
    return this.thread.post(`${body}\n\n<details>\n<summary>Trace: ${summary}</summary>\n\n${trace}\n\n</details>`);
  }

  async ack(): Promise<void> {
    // A PR comment has no typing indicator; the reply is the acknowledgment.
  }

  async thought(markdown: string): Promise<void> {
    this.thoughts.push(markdown);
  }

  async action(call: ToolTrace): Promise<void> {
    this.calls.set(call.id, call);
  }

  async respond(markdown: string): Promise<void> {
    await this.flush(markdown);
  }

  async ask(markdown: string): Promise<void> {
    await this.flush(`❓ ${markdown}`);
  }

  async error(markdown: string): Promise<void> {
    await this.flush(`⚠️ ${markdown}`);
  }

  async link(): Promise<void> {
    // The PR is where we are.
  }
}
