import type { ApprovalResponse } from 'operon-agents';

import { ReverseRpcController } from '../base-controller.ts';
import type { ApprovalPanelData } from '../types.ts';

export class ApprovalController extends ReverseRpcController<ApprovalPanelData, ApprovalResponse> {
  protected createCancelResponse(reason: string): ApprovalResponse {
    return { decision: 'cancelled', feedback: reason };
  }

  protected override autoResolveFor(
    resolvedPayload: ApprovalPanelData,
    response: ApprovalResponse,
    queuedPayload: ApprovalPanelData,
  ): ApprovalResponse | undefined {
    if (response.decision !== 'approved') return undefined;
    if (response.scope !== 'session') return undefined;
    if (resolvedPayload.action !== queuedPayload.action) return undefined;
    // Inherit the session-scoped approval; the feedback described the first request only.
    return { decision: 'approved', scope: 'session' };
  }
}
