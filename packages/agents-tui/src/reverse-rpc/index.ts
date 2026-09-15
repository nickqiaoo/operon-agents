import type { ApprovalController } from './approval/controller.ts';
import type { QuestionController } from './question/controller.ts';
import { ReverseRpcModalCoordinator } from './modal-coordinator.ts';
import type { ApprovalPanelData, QuestionPanelData } from './types.ts';

export interface ReverseRPCUIHooks {
  readonly showApprovalPanel: (payload: ApprovalPanelData) => void;
  readonly hideApprovalPanel: () => void;
  readonly showQuestionDialog: (payload: QuestionPanelData) => void;
  readonly hideQuestionDialog: () => void;
}

export function registerReverseRPCHandlers(
  approvalController: ApprovalController,
  questionController: QuestionController,
  uiHooks: ReverseRPCUIHooks,
): Array<() => void> {
  const modalCoordinator = new ReverseRpcModalCoordinator(uiHooks);

  // Setup UI hooks for controllers
  approvalController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showApproval(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('approval');
    },
  });

  questionController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showQuestion(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('question');
    },
  });

  return [
    () => {
      modalCoordinator.clear();
    },
  ];
}
