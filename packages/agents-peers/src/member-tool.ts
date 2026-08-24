/**
 * The member `Hub` tool — the surface a TEAMMATE is born with. General peer messaging, gated by
 * the network's visibility policy. Only sessions whose `params.peers` names a `member` carry it
 * (what the spawn factory sets); ordinary sessions get the `Team` tool instead, whose reach is
 * their own members only.
 *
 * `wait` is deliberately absent: a teammate answers by being woken, and a blocking op would only
 * add the one thing this design has none of — a way for two agents to deadlock.
 */
import { z } from "zod";
import type { Tool, ToolResult } from "operon-agents-core";
import { defineTool } from "./define-tool.ts";
import type { AgentRef } from "./directory.ts";
import type { PeerNetworkHandle } from "./network.ts";

const hubInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list").describe("List the peers you can address.") }),
  z.object({
    op: z.literal("send").describe("Send a message to a peer. Returns immediately; never waits for a reply."),
    to: z.string().describe("Exact agent name from the roster."),
    message: z.string().describe("Plain prose. Share paths and ids, not pasted blobs."),
    replyTo: z.string().optional().describe("messageId you are answering, when this is a reply."),
    interrupt: z.boolean().optional().describe("Cut into the peer's current work instead of waiting for its turn boundary. Reserve for 'stop, you're going the wrong way'."),
  }),
  z.object({ op: z.literal("inbox").describe("Read messages routed to you that never reached your conversation.") }),
]);

function rosterRow(ref: AgentRef): Record<string, unknown> {
  return {
    name: ref.agentId,
    type: ref.type,
    status: ref.status,
    ...(ref.description !== undefined ? { description: ref.description } : {}),
    ...(ref.labels !== undefined && ref.labels.length > 0 ? { teams: ref.labels } : {}),
  };
}

function text(body: string, details?: Record<string, unknown>, isError?: boolean): ToolResult {
  return { content: [{ type: "text", text: body }], ...(details !== undefined ? { details } : {}), ...(isError === true ? { isError: true } : {}) };
}

export function buildMemberTool(network: PeerNetworkHandle, selfName: string): Tool {
  const description = [
    "Coordinate with your peers: the teammates working alongside you, and whoever created your team.",
    "",
    "- `list` shows who you can address, with their name and status.",
    "- `send` hands a message to one peer and returns immediately — it does NOT wait for a reply.",
    "  The peer sees it at its next turn boundary and answers in its own turn.",
    "- `inbox` drains messages routed to you that never reached your conversation.",
    "",
    "Rules:",
    "- Address a peer by its exact name from the roster. NEVER invent a name.",
    "- A `failed` receipt is final for that reason — do not retry the same send.",
    "- A `parked` peer is asleep, not gone: messaging one wakes it.",
    "- Plain prose only. Share paths and ids rather than pasting large blobs.",
    "- Do not use a peer for something a tool can answer yourself.",
  ].join("\n");

  return defineTool({
    name: "Hub",
    description,
    params: hubInput,
    resolve: (args) => ({
      // Read-only ops are auto-approved by the host's policy; `send` is not — it wakes a peer and
      // spends its budget.
      approvalRule: `hub.${args.op}`,
      display: {
        title: "Hub",
        detail: args.op === "send" ? `${args.op} → ${args.to}` : args.op,
      },
      run: async (ctx): Promise<ToolResult> => {
        // The member's identity is its birth name — and it belongs to the ROOT frame only.
        // A delegation the member spawns is an ordinary delegation, not a peer.
        if (ctx.address !== undefined && ctx.address !== "main") {
          return text("Peer messaging belongs to this session's root agent; a delegation reports to its spawner instead.", { op: args.op }, true);
        }

        if (args.op === "list") {
          const roster = await network.visiblePeers(selfName);
          return text(
            roster.length === 0 ? "No peers are visible to you." : JSON.stringify({ you: selfName, peers: roster.map(rosterRow) }, null, 2),
            { op: args.op, count: roster.length },
          );
        }

        if (args.op === "inbox") {
          const pending = await network.drainInbox(selfName);
          return text(
            pending.length === 0
              ? "No undelivered peer messages."
              : JSON.stringify(pending.map((m) => ({ from: m.from, messageId: m.messageId, content: m.content, queuedAt: m.queuedAt })), null, 2),
            { op: args.op, count: pending.length },
          );
        }

        const self = await network.getAgent(selfName);
        if (self === undefined) return text("You are not on the peer roster.", { op: args.op }, true);
        if (network.overBudget(selfName, ctx.turnId)) {
          return text("Outbound peer-message budget for this turn is exhausted. Continue your work; send again in a later turn.", { op: args.op, reason: "quota_exceeded" }, true);
        }
        const receipt = await network.route(self, args.to, args.message, {
          ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
          ...(args.interrupt !== undefined ? { interrupt: args.interrupt } : {}),
        });
        const body =
          receipt.status === "failed"
            ? `send failed (${receipt.reason}): ${receipt.detail ?? ""}`.trim()
            : `Message ${receipt.messageId} delivered to ${receipt.to}. It will answer in its own turn — do not wait for it.`;
        return text(body, { op: args.op, ...receipt }, receipt.status === "failed");
      },
    }),
  });
}
