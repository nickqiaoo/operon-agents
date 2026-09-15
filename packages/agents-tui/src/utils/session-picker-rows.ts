import type { SessionSummary } from 'operon-agents';

import type { SessionRow } from '../components/dialogs/session-picker.ts';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: null,
      work_dir: session.workDir,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: undefined,
    }));
}
