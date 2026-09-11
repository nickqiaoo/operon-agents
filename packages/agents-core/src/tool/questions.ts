/**
 * Interactive-question contract, defined at tool altitude so tools can consume it
 * from ToolRunContext without reaching up into permission/ (same pattern as
 * BackgroundSpawner in background.ts). permission/'s Responder extends
 * QuestionResponder, so a session responder threads down unchanged.
 */

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
}

export interface QuestionRequest {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly questions: readonly QuestionItem[];
}

export type QuestionAnswerValue = string | readonly string[];
export type QuestionAnswers = Readonly<Record<string, QuestionAnswerValue>>;
export type QuestionAnswerMethod = "option" | "freeform" | "mixed" | (string & {});

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod;
}

export type QuestionResult = QuestionResponse | QuestionAnswers | null;

/**
 * The client channel for interactive questions. `requestQuestion` stays optional:
 * a connected client that cannot render questions simply omits it, and tools fail
 * soft with a "ask in text instead" result.
 */
export interface QuestionResponder {
  requestQuestion?(request: QuestionRequest, options?: { readonly signal?: AbortSignal }): Promise<QuestionResult>;
  /**
   * Whether anyone is there to answer a question right now. `false` means the session is
   * headless -- a durable session driven over an API, with nobody attached -- so a question
   * suspends the run durably (it surfaces on the paused run's pending list, answered through
   * `Runner.resume`) instead of being asked into the void. Absent means live. Mirrors
   * `Responder.isLiveApprover` for approvals.
   */
  isLiveQuestioner?(): boolean;
}
