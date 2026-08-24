import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolAccesses } from "../access.ts";
import type {
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionItem,
  QuestionResponder,
  QuestionResponse,
  QuestionResult,
} from "../questions.ts";
import type { ToolResult } from "../types.ts";

const QUESTION_DISMISSED_MESSAGE = "User dismissed the question without answering.";
const QUESTION_UNSUPPORTED_FAILURE_MESSAGE =
  "The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.";
// Answers come back keyed by question text with option labels as values, so both
// must be unambiguous: question texts unique across the call, option labels unique
// within each question. Otherwise the model cannot tell which answer maps to which.
const QUESTION_UNIQUENESS_MESSAGE =
  "Question texts must be unique across questions, and option labels must be unique within each question.";

const QuestionOptionSchema = z.object({
  label: z.string().describe("Concise display text (1-5 words). If recommended, append '(Recommended)'."),
  description: z.string().default("").describe("Brief explanation of trade-offs or implications."),
});

const QuestionItemSchema = z.object({
  question: z.string().describe("A specific, actionable question. End with '?'."),
  header: z.string().default("").describe("Short category tag (max 12 chars, e.g. 'Auth', 'Style')."),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically."),
  multi_select: z.boolean().default(false).describe("Whether the user can select multiple options."),
});

const AskUserQuestionInput = z.object({
  background: z
    .boolean()
    .default(false)
    .describe("Set true to ask in the background and return immediately with a task_id when background tasks are available.")
    .optional(),
  questions: z.array(QuestionItemSchema).min(1).max(4).describe("The questions to ask the user (1-4 questions)."),
});

type AskUserQuestionInput = z.infer<typeof AskUserQuestionInput>;

const ASK_USER_QUESTION_DESCRIPTION = [
  "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:",
  "1. Collect user preferences or requirements before proceeding",
  "2. Resolve ambiguous or underspecified instructions",
  "3. Let the user decide between implementation approaches as you work",
  "4. Present concrete options when multiple valid directions exist",
  "",
  "**When NOT to use:**",
  "- When you can infer the answer from context — be decisive and proceed",
  "- Trivial decisions that don't materially affect the outcome",
  "",
  "Overusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.",
  "",
  "**Usage notes:**",
  "- Users always have an \"Other\" option for custom input — don't create one yourself",
  "- Use multi_select to allow multiple answers to be selected for a question",
  "- Keep option labels concise (1-5 words), use descriptions for trade-offs and details",
  "- Each question should have 2-4 meaningful, distinct options",
  "- Answers come back keyed by question text with the chosen option labels as values, so keep question texts unique across the call and option labels unique within each question",
  "- You can ask 1-4 questions at a time; group related questions to minimize interruptions",
  "- If you recommend a specific option, list it first and append \"(Recommended)\" to its label",
  "- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately when background tasks are available. The answer arrives automatically in a later turn; continue with other work and never fabricate or predict the answer.",
].join("\n");

export const askUserQuestionTool = defineTool({
  name: "AskUserQuestion",
  description: ASK_USER_QUESTION_DESCRIPTION,
  params: AskUserQuestionInput,
  resolve: (args) => ({
    approvalRule: "AskUserQuestion",
    accesses: ToolAccesses.none(),
    display: {
      title: args.background === true ? "Start background question" : "Ask user question",
      detail: questionDescription(args.questions),
    },
    run: async (ctx): Promise<ToolResult> => {
      // Continuation of a durable suspension: the caller's answer arrived via Runner.resume.
      if (ctx.resumed !== undefined) {
        return questionResultToToolResult(ctx.resumed.answer as QuestionResult);
      }
      // Guard the answer-keying contract before asking: duplicate question texts or
      // option labels make the returned answers ambiguous. Fail soft with a retry hint.
      const uniquenessError = questionUniquenessError(args.questions);
      if (uniquenessError !== null) return textResult(uniquenessError, true);
      if (args.background === true) {
        const spawnQuestion = ctx.background?.spawnQuestion?.bind(ctx.background);
        if (spawnQuestion === undefined) {
          return textResult("Background questions are unavailable because no BackgroundManager is attached.", true);
        }
        const task = spawnQuestion(
          (signal) => executeQuestion(ctx.responder, args, { turnId: ctx.turnId, toolCallId: ctx.toolCallId, signal }),
          questionDescription(args.questions),
          {
            questionCount: args.questions.length,
            ...(ctx.address !== undefined ? { parentAddress: ctx.address } : {}),
            toolCallId: ctx.toolCallId,
          },
        );
        return textResult(
          [
            `task_id: ${task.taskId}`,
            `description: ${questionDescription(args.questions)}`,
            `status: ${task.status}`,
            "automatic_notification: true",
            "next_step: Continue your current work; the answer will arrive automatically when the user responds.",
            "next_step: Use BackgroundOutput with this task_id for a non-blocking status/answer snapshot.",
          ].join("\n"),
        );
      }
      // No responder at all (headless / durable session): suspend instead of failing — the
      // questions surface on the paused run and the answer comes back through Runner.resume.
      // A responder WITHOUT requestQuestion stays the soft-failure path below: that client is
      // live but cannot render questions, so pausing durably would hang the conversation.
      if (ctx.responder === undefined) {
        ctx.suspend({ kind: "question", display: { questions: toQuestionItems(args.questions) } });
        // suspend() must interrupt (typed `never`); a non-conforming context falling
        // through would misreport the pause as the "unsupported" soft failure below.
        throw new Error("ToolRunContext.suspend() returned instead of interrupting the run — non-conforming implementation.");
      }
      return executeQuestion(ctx.responder, args, { turnId: ctx.turnId, toolCallId: ctx.toolCallId, signal: ctx.signal });
    },
  }),
});

async function executeQuestion(
  responder: QuestionResponder | undefined,
  args: AskUserQuestionInput,
  ctx: { readonly turnId: string; readonly toolCallId: string; readonly signal: AbortSignal },
): Promise<ToolResult> {
  if (responder?.requestQuestion === undefined) return textResult(QUESTION_UNSUPPORTED_FAILURE_MESSAGE, true);

  const result = await responder.requestQuestion(
    { turnId: ctx.turnId, toolCallId: ctx.toolCallId, questions: toQuestionItems(args.questions) },
    { signal: ctx.signal },
  );
  return questionResultToToolResult(result);
}

function toQuestionItems(questions: AskUserQuestionInput["questions"]): QuestionItem[] {
  return questions.map((question) => ({
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({ label: option.label, description: option.description })),
    multiSelect: question.multi_select,
  }));
}

function questionResultToToolResult(result: QuestionResult): ToolResult {
  const normalized = normalizeQuestionResult(result);
  if (normalized === null || Object.keys(normalized.answers).length === 0) {
    return textResult(JSON.stringify({ answers: {}, note: QUESTION_DISMISSED_MESSAGE }));
  }
  return textResult(JSON.stringify({ answers: normalized.answers }));
}

function normalizeQuestionResult(
  result: QuestionResult,
): { readonly answers: QuestionAnswers; readonly method?: QuestionAnswerMethod | undefined } | null {
  if (result === null) return null;
  if (isQuestionResponse(result)) return { answers: result.answers, method: result.method };
  return { answers: result };
}

function isQuestionResponse(result: Exclude<QuestionResult, null>): result is QuestionResponse {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  if (!Object.hasOwn(result, "answers")) return false;
  const answers = (result as { readonly answers?: unknown }).answers;
  return typeof answers === "object" && answers !== null && !Array.isArray(answers);
}

/**
 * Reject a question set that would produce ambiguous answers: a question text
 * repeated across the call, or an option label repeated within one question.
 * Returns a model-facing retry message, or null when the set is unambiguous.
 */
function questionUniquenessError(questions: AskUserQuestionInput["questions"]): string | null {
  const questionTexts = new Set<string>();
  for (const q of questions) {
    if (questionTexts.has(q.question)) {
      return `Invalid questions: duplicate question text ${JSON.stringify(q.question)}. ${QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.`;
    }
    questionTexts.add(q.question);
    const labels = new Set<string>();
    for (const option of q.options) {
      if (labels.has(option.label)) {
        return `Invalid questions: duplicate option label ${JSON.stringify(option.label)} in question ${JSON.stringify(q.question)}. ${QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.`;
      }
      labels.add(option.label);
    }
  }
  return null;
}

function questionDescription(questions: AskUserQuestionInput["questions"]): string {
  const first = questions[0]?.question.trim();
  const label = first === undefined || first.length === 0 ? "Ask user question" : first;
  return questions.length <= 1 ? label : `${label} (+${String(questions.length - 1)} more)`;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}
