import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from 'operon-agents';

import { adaptApprovalRequest } from './adapter.ts';
import type { ApprovalController } from './controller.ts';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
): ApprovalHandler {
  return async (request, options): Promise<ApprovalResponse> => {
    const signal = options?.signal;
    if (signal?.aborted) return { decision: 'cancelled', feedback: 'request aborted' };
    try {
      const response = await controller.show(adaptApprovalRequest(request), signal);
      onResponse?.(request, response);
      return response;
    } catch {
      const response: ApprovalResponse = { decision: 'cancelled', feedback: 'approval handler failed' };
      onResponse?.(request, response);
      return response;
    }
  };
}
