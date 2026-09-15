import { ChoicePickerComponent, type ChoiceOption } from './choice-picker.ts';

import { listCustomThemesSync } from '../../theme/custom-theme-loader.ts';
import type { ThemeName } from '../../theme/index.ts';

const THEME_OPTIONS: readonly ChoiceOption[] = [
  { value: 'auto', label: 'Auto (match terminal)' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export interface ThemeSelectorOptions {
  readonly currentValue: ThemeName;
  readonly onSelect: (theme: ThemeName) => void;
  readonly onCancel: () => void;
}

export class ThemeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThemeSelectorOptions) {
    const customThemes = listCustomThemesSync();
    const options: ChoiceOption[] = [
      ...THEME_OPTIONS,
      ...customThemes.map((name) => ({ value: name, label: `Custom: ${name}` })),
    ];
    super({
      title: 'Select theme',
      options,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
