import type { QuestionHandler, QuestionRequest, QuestionResult } from 'operon-agents';

import type { QuestionPanelData, QuestionPanelResponse } from '../types.ts';
import type { QuestionController } from './controller.ts';

export function createQuestionAskHandler(controller: QuestionController): QuestionHandler {
  return async (request, options): Promise<QuestionResult> => {
    const signal = options?.signal;
    if (signal?.aborted) return null;
    try {
      const answers = await controller.show(adaptQuestionRequest(request), signal);
      return adaptQuestionAnswers(request, answers);
    } catch {
      return null;
    }
  };
}

export function adaptQuestionRequest(request: QuestionRequest): QuestionPanelData {
  const id = request.toolCallId;
  return {
    id,
    tool_call_id: id,
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header.length > 0 ? question.header : undefined,
      multi_select: question.multiSelect,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description.length > 0 ? option.description : undefined,
      })),
    })),
  };
}

/** Answers are keyed by question text; a multi-select answer is the chosen labels as a list. */
export function adaptQuestionAnswers(request: QuestionRequest, response: QuestionPanelResponse): QuestionResult {
  const answers: Record<string, string | readonly string[]> = {};
  for (let i = 0; i < request.questions.length; i++) {
    const question = request.questions[i];
    const answer = response.answers[i];
    if (question === undefined || typeof answer !== 'string' || answer.length === 0) continue;
    answers[question.question] = question.multiSelect ? answer.split(', ').filter((s) => s.length > 0) : answer;
  }
  if (Object.keys(answers).length === 0) return null;
  return { answers, method: response.method };
}
