import { ChoicePickerComponent, type ChoiceOption } from './choice-picker.ts';

export type SettingsSelection = 'model' | 'thinking' | 'permission' | 'theme' | 'editor' | 'usage' | 'context';

const SETTINGS_OPTIONS: readonly ChoiceOption[] = [
  { value: 'model', label: 'Model', description: 'Switch the active model and thinking level.' },
  { value: 'thinking', label: 'Thinking', description: 'Set how much the model thinks before answering.' },
  { value: 'permission', label: 'Permission', description: 'Choose how tool actions are approved.' },
  { value: 'theme', label: 'Theme', description: 'Change the terminal UI theme.' },
  { value: 'editor', label: 'Editor', description: 'Set the external editor command.' },
  { value: 'usage', label: 'Usage', description: 'Show session tokens and the context window.' },
  { value: 'context', label: 'Context', description: 'Break down what fills the context window.' },
];

function isSettingsSelection(value: string): value is SettingsSelection {
  return SETTINGS_OPTIONS.some((option) => option.value === value);
}

export interface SettingsSelectorOptions {
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: 'Settings',
      options: [...SETTINGS_OPTIONS],
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
