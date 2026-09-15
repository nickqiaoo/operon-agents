import { ReverseRpcController } from '../base-controller.ts';
import type { QuestionPanelData, QuestionPanelResponse } from '../types.ts';

export class QuestionController extends ReverseRpcController<
  QuestionPanelData,
  QuestionPanelResponse
> {
  protected createCancelResponse(_reason: string): QuestionPanelResponse {
    return { answers: [] };
  }
}
