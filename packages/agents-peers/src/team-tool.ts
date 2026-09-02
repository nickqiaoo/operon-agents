/**
 * The `Team` tool — the CREATOR surface. What an ordinary agent holds from birth: it can form a
 * team, spawn session teammates into it, and talk to exactly those members. It has no general
 * peer messaging — that is the member `Hub`, which only spawned teammates are born with.
 *
 * `wait` is deliberately absent here too: teammates report back by messaging, which wakes the
 * creator; a blocking op would only add a way to deadlock.
 */
import { z } from "zod";
import type { Tool, ToolResult } from "operon-agents-core";
import { defineTool } from "./define-tool.ts";
import type { AgentRef } from "./directory.ts";
import type { PeerExtensionOptions, PeerNetworkHandle, TeamCaller } from "./network.ts";

const teamInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create").describe("Form a team. Do this once, before spawning members."),
    name: z.string().describe('Short team name, e.g. "db-migration". Letters, digits, _ and - only.'),
  }),
  z.object({
    op: z.literal("spawn").describe("Create one teammate in your team. It starts on the prompt immediately and reports back by message."),
    type: z.string().describe("A teammate type configured by the host. An unknown type fails and lists what is available."),
    name: z.string().describe('The teammate\'s name — unique within the team; it is how you and its teammates address it. "lead" is reserved for you.'),
    prompt: z.string().describe("Its initial assignment. Plain prose; share paths and ids, not pasted blobs."),
    team: z.string().optional().describe("Which of your teams it joins. Only needed when you created more than one."),
  }),
  z.object({
    op: z.literal("send").describe("Message one of YOUR team's members. Returns immediately; never waits for a reply."),
    to: z.string().describe("Member name (or id) from Team list."),
    message: z.string().describe("Plain prose."),
    team: z.string().optional().describe("Which of your teams the member is in. Only needed when the same name exists in several of your teams."),
    replyTo: z.string().optional().describe("messageId you are answering, when this is a reply."),
    interrupt: z.boolean().optional().describe("Cut into the member's current work instead of waiting for its turn boundary. Reserve for 'stop, you're going the wrong way'."),
  }),
  z.object({ op: z.literal("list").describe("List the members of teams you created, with their status.") }),
  z.object({ op: z.literal("inbox").describe("Read messages routed to you that never reached your conversation.") }),
]);

function memberRow(ref: AgentRef): Record<string, unknown> {
  return {
    name: ref.name ?? ref.agentId,
    ...(ref.name !== undefined ? { id: ref.agentId } : {}),
    type: ref.type,
    status: ref.status,
    ...(ref.description !== undefined ? { description: ref.description } : {}),
    ...(ref.labels !== undefined && ref.labels.length > 0 ? { teams: ref.labels } : {}),
  };
}

function text(body: string, details?: Record<string, unknown>, isError?: boolean): ToolResult {
  return { content: [{ type: "text", text: body }], ...(details !== undefined ? { details } : {}), ...(isError === true ? { isError: true } : {}) };
}

export function buildTeamTool(network: PeerNetworkHandle, sessionIdOf: () => string | undefined, options: PeerExtensionOptions): Tool {
  const description = [
    "Form and run a team of durable agents for work that needs several of them talking to each other.",
    "",
    "- `create` forms a team (do it once).",
    "- `spawn` creates one teammate in it: an independent agent that starts on your prompt right away,",
    "  works in its own session, and reports back by message — which arrives in a LATER turn of yours.",
    "- `send` messages one of your members; `list` shows them; `inbox` drains undelivered messages.",
    "",
    "Rules:",
    "- Teammates can message you and each other directly; you do not relay between them.",
    "- `send` and `spawn` return immediately. NEVER wait or poll for a reply — continue your work;",
    "  reports arrive on their own.",
    "- A `failed` receipt is final for that reason — do not retry the same send.",
    "- A `parked` member is asleep, not gone: messaging it wakes it.",
    "- Use a plain Agent(...) delegation for quick self-contained work; spawn a teammate only for",
    "  work that needs an agent that outlives one call and converses.",
  ].join("\n");

  return defineTool({
    name: "Team",
    description,
    params: teamInput,
    resolve: (args) => ({
      // `spawn` and `send` wake agents and spend budget; reads are cheap.
      approvalRule: `team.${args.op}`,
      display: {
        title: "Team",
        detail:
          args.op === "spawn" ? `spawn ${args.type} "${args.name}"`
          : args.op === "send" ? `send → ${args.to}`
          : args.op === "create" ? `create ${args.name}`
          : args.op,
      },
      run: async (ctx): Promise<ToolResult> => {
        const sessionId = sessionIdOf();
        if (sessionId === undefined) return text("Team coordination is unavailable in this session.", { op: args.op }, true);
        const address = ctx.address ?? "main";
        const isRoot = address === "main";
        const selfId = isRoot ? sessionId : address.slice(address.lastIndexOf("/") + 1);
        const caller: TeamCaller = {
          agentId: selfId,
          sessionId,
          address,
          ...(isRoot && options.type !== undefined ? { type: options.type } : {}),
          ...(isRoot && options.description !== undefined ? { description: options.description } : {}),
        };

        if (args.op === "create") {
          const result = await network.createTeam(caller, args.name);
          if ("error" in result) return text(result.error, { op: args.op }, true);
          return text(
            [
              `Team "${args.name}" formed.`,
              "",
              "Recruit with Team spawn(type, name, prompt). Members join automatically and can message you (as \"lead\") and each other by name.",
            ].join("\n"),
            { op: args.op, label: result.label },
          );
        }

        if (args.op === "spawn") {
          if (network.overBudget(selfId, ctx.turnId)) {
            return text("Outbound peer budget for this turn is exhausted. Continue your work; spawn again in a later turn.", { op: args.op, reason: "quota_exceeded" }, true);
          }
          const result = await network.spawnTeammate(selfId, args);
          if ("error" in result) return text(result.error, { op: args.op }, true);
          return text(
            [
              `Teammate "${result.name}" (${args.type}) is working on it.`,
              "",
              "It reports back by message in a later turn — do not wait for it. Team send to steer it; Team list to see your members.",
            ].join("\n"),
            { op: args.op, name: result.name, agentId: result.agentId, sessionId: result.sessionId, team: result.team, receipt: result.receipt },
          );
        }

        if (args.op === "list") {
          const members = await network.ownedMembers(selfId);
          return text(
            members.length === 0 ? "You have no team members. Team create, then Team spawn." : JSON.stringify({ you: selfId, members: members.map(memberRow) }, null, 2),
            { op: args.op, count: members.length },
          );
        }

        if (args.op === "inbox") {
          const pending = await network.drainInbox(selfId);
          return text(
            pending.length === 0
              ? "No undelivered peer messages."
              : JSON.stringify(pending.map((m) => ({ from: m.from, messageId: m.messageId, content: m.content, queuedAt: m.queuedAt })), null, 2),
            { op: args.op, count: pending.length },
          );
        }

        if (network.overBudget(selfId, ctx.turnId)) {
          return text("Outbound peer-message budget for this turn is exhausted. Continue your work; send again in a later turn.", { op: args.op, reason: "quota_exceeded" }, true);
        }
        const receipt = await network.sendWithinTeam(selfId, args.to, args.message, {
          ...(args.team !== undefined ? { team: args.team } : {}),
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
