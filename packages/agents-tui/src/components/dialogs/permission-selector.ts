import type { PermissionMode } from 'operon-agents';

import { PERMISSION_MODES, PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_DISPLAY_NAMES, isPermissionMode } from '../../utils/permission-mode.ts';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker.ts';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = PERMISSION_MODES.map((mode) => ({
  value: mode,
  label: PERMISSION_MODE_DISPLAY_NAMES[mode],
  description: PERMISSION_MODE_DESCRIPTIONS[mode],
  ...(mode === 'auto' ? { tone: 'danger' as const } : {}),
}));

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly initialValue?: PermissionMode;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: 'Select permission mode',
      options: [...PERMISSION_OPTIONS],
      currentValue: opts.currentValue,
      initialValue: opts.initialValue,
      onSelect: (value) => {
        if (isPermissionMode(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
