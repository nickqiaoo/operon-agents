import type { PermissionMode } from 'operon-agents';

export const PERMISSION_MODES: readonly PermissionMode[] = ['manual', 'workspace', 'yolo', 'auto'];

export const PERMISSION_MODE_DISPLAY_NAMES: Readonly<Record<PermissionMode, string>> = {
  manual: 'Always Ask',
  workspace: 'Workspace',
  yolo: 'Ask When Needed',
  auto: 'Never Ask',
};

export const PERMISSION_MODE_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  manual: 'Auto-read only; everything else needs your approval first.',
  workspace: 'Operations confined to the workspace run automatically; anything outside it asks.',
  yolo: 'Routine edits and commands run automatically; risky actions, questions, and plans still ask.',
  auto: 'Never interrupts you; everything runs and is decided automatically.',
};

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}
