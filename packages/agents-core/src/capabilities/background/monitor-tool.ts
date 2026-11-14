import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { commandAccesses, commandStarter, prepareBackgroundLog } from "../../tool/builtin/bash.ts";
import { matchesBashRule } from "../../tool/support/bash-rule-match.ts";
import { destructiveWarning } from "../../tool/support/bash-destructive.ts";
import { escapeRuleSubjectLiteral } from "../../tool/support/rule-match.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
/** Longer deadlines are accepted and capped here, as Claude Code does. */
const MAX_TIMEOUT_MS = 1_800_000;

/**
 * Claude Code's Monitor tool description (2.1.321), minus what this framework does not have
 * (the WebSocket source, push notifications) and with its stop tool's name.
 */
const MONITOR_DESCRIPTION = [
  "Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.",
  "",
  "Pick by how many notifications you need:",
  '- **One** ("tell me when the server is ready / the build finishes") → use **Bash with `run_in_background`** and a command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`. You get a single completion notification when it exits.',
  '- **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (`tail -f`, `inotifywait -m`, `while true`).',
  '- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.',
  "",
  "Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.",
  "",
  "  # Each matching log line is an event",
  '  tail -f /var/log/app.log | grep --line-buffered "ERROR"',
  "",
  "  # Each file change is an event",
  "  inotifywait -m --format '%e %f' /watched/dir",
  "",
  "  # Poll GitHub for new PR comments and emit one line per new comment",
  "  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "  while true; do",
  "    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  '    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq \'.[] | "\\(.user.login): \\(.body)"\'',
  "    last=$now; sleep 30",
  "  done",
  "",
  "  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes",
  '  prev=""',
  "  while true; do",
  "    s=$(gh pr checks 123 --json name,bucket)",
  '    cur=$(jq -r \'.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"\' <<<"$s" | sort)',
  '    comm -13 <(echo "$prev") <(echo "$cur")',
  "    prev=$cur",
  '    jq -e \'all(.bucket!="pending")\' <<<"$s" >/dev/null && break',
  "    sleep 30",
  "  done",
  "",
  '**Don\'t use an unbounded command for a single notification.** `tail -f`, `inotifywait -m`, and `while true` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use Bash `run_in_background` with an `until` loop instead (one notification, ends in seconds). Note that `tail -f log | grep -m 1 ...` does *not* fix this: if the log goes quiet after the match, `tail` never receives SIGPIPE and the pipeline hangs anyway.',
  "",
  "**Script quality:**",
  "- Every pipe stage must flush per line or matches sit in its buffer unseen: `grep` needs `--line-buffered`, `awk` needs `fflush()`. `head` cannot flush at all — `| head -N` delivers nothing until N matches accumulate, then ends the stream.",
  "- In poll loops, handle transient failures (`curl ... || true`) — one failed request shouldn't kill the monitor.",
  "- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.",
  '- Write a specific `description` — it appears in every notification ("errors in deploy.log" not "watching logs").',
  "- Only stdout is the event stream. Stderr goes to the stderr log (readable via Read) but does not trigger notifications — for a command you run directly (e.g. `python train.py 2>&1 | grep --line-buffered ...`), merge stderr with `2>&1` so its failures reach your filter. (No effect on `tail -f` of an existing log — that file only contains what its writer redirected.)",
  "",
  "**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to \"still running.\" Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.",
  "",
  "  # Wrong — silent on crash, hang, or any non-success exit",
  '  tail -f run.log | grep --line-buffered "elapsed_steps="',
  "",
  "  # Right — one alternation covering progress + the failure signatures you'd act on",
  '  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"',
  "",
  "For poll loops checking job state, emit on every terminal status (`succeeded|failed|cancelled|timeout`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.",
  "",
  '**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you\'d act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.',
  "",
  "Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.",
  "",
  `The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Every monitor expires after \`timeout_ms\` (default 5 minutes, at most 30 minutes): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use BackgroundStop to cancel early.`,
].join("\n");

const MonitorInput = z.object({
  command: z.string().min(1, "Command cannot be empty.").describe("Shell command or script. Each stdout line is an event; exit ends the watch."),
  description: z.string().min(1).describe("Short human-readable description of what you are monitoring (shown in notifications)."),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(DEFAULT_TIMEOUT_MS)
    .describe(
      `Kill the monitor after this deadline. Default ${String(DEFAULT_TIMEOUT_MS)}ms. Deadlines above ${String(MAX_TIMEOUT_MS)}ms are capped to ${String(MAX_TIMEOUT_MS)}ms. You are notified at expiry and can re-arm.`,
    ),
  cwd: z
    .string()
    .optional()
    .describe("The working directory in which to run the command. When omitted, the command runs in the session's working directory."),
});

/**
 * The Monitor tool. A shell command run like a background Bash command, except its stdout is an
 * event stream: each line (batched over 200ms, rate-limited) reaches the conversation while it
 * runs. Permission works exactly as for Bash — same accesses, same rule syntax — because what
 * runs is a shell command; the rules live under `Monitor(...)` so allowing a watch does not also
 * allow running the same text as a one-off command, nor the other way round.
 */
export function monitorTool(): Tool {
  return defineTool({
    name: "Monitor",
    description: MONITOR_DESCRIPTION,
    parameters: MonitorInput,
    toAutoApprovalInput: (args) => args.command,
    resolve(args, ctx) {
      const warning = destructiveWarning(args.command);
      return {
        accesses: commandAccesses(args, ctx.environment),
        display: {
          title: `Monitor: ${args.description}`,
          command: args.command,
          ...(warning !== undefined ? { warning } : {}),
        },
        approvalRule: `Monitor(${escapeRuleSubjectLiteral(args.command)})`,
        matchesRule: (ruleArgs) => matchesBashRule(ruleArgs, args.command),
        run: async (runCtx): Promise<ToolResult> => {
          const spawn = runCtx.background?.spawnMonitor?.bind(runCtx.background);
          if (spawn === undefined) return errorResult("Monitor is not available for this agent: it needs the background capability.");
          const environment = runCtx.environment;
          let logPath: string;
          try {
            logPath = await prepareBackgroundLog(environment);
          } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
          }
          const stderrPath = logPath.replace(/\.log$/, "") + ".stderr.log";
          const timeoutMs = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
          const wrapped = args.command;
          const taskId = spawn(commandStarter(environment, args.cwd ?? environment.getcwd(), wrapped, logPath, stderrPath), args.command, args.description, {
            environment,
            logPath,
            stderrPath,
            timeoutMs,
            ...(runCtx.address !== undefined ? { parentAddress: runCtx.address } : {}),
            ...(runCtx.toolCallId !== undefined ? { toolCallId: runCtx.toolCallId } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `Monitor started (task ${taskId}, timeout ${String(timeoutMs)}ms). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.\n` +
                  `output_log: ${logPath}\n` +
                  `stderr_log: ${stderrPath}`,
              },
            ],
          };
        },
      };
    },
  });
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
