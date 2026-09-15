import type { ThinkingLevel } from 'operon-agents';
import { Container, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from 'operon-pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '../../constant/symbols.ts';
import { currentTheme } from '../../theme/index.ts';
import { SearchableList } from '../../utils/searchable-list.ts';
import { modelDisplayName, providerDisplayName, thinkingLevelsFor, type ModelCatalog, type ModelCatalogEntry } from '../../utils/model-catalog.ts';
import { thinkingLabel } from '../../utils/thinking.ts';

import type { ChoiceOption } from './choice-picker.ts';

interface ModelChoice {
  readonly id: string;
  readonly entry: ModelCatalogEntry;
  /** Model display name (left column). */
  readonly name: string;
  /** Provider display name (right column). */
  readonly provider: string;
  /** Combined text the fuzzy filter matches against (name + provider). */
  readonly label: string;
}

export interface ModelSelection {
  readonly id: string;
  /** Chosen thinking level, or undefined for a model that does not reason. */
  readonly thinking: ThinkingLevel | undefined;
}

export function createModelChoiceOptions(models: ModelCatalog): readonly ChoiceOption[] {
  return Object.values(models).map((entry) => ({
    value: entry.id,
    label: `${entry.displayName} (${providerDisplayName(entry.provider)})`,
  }));
}

export interface ModelSelectorOptions {
  readonly models: ModelCatalog;
  readonly currentValue: string;
  readonly selectedValue?: string;
  /** Live thinking level of the active session; highlights the active segment for that model. */
  readonly currentThinkingLevel: ThinkingLevel;
  readonly title?: string;
  readonly searchable?: boolean;
  readonly pageSize?: number;
  /** Rendered as warning-colored lines below the key hints (e.g. the mid-conversation notice). */
  readonly warning?: string;
  /** Set to false to hide the Thinking footer and disable ←/→ level switching. */
  readonly thinkingControl?: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

function createModelChoices(models: ModelCatalog): readonly ModelChoice[] {
  return Object.values(models)
    .map((entry) => {
      const name = modelDisplayName(entry.id, entry);
      const provider = providerDisplayName(entry.provider);
      return { id: entry.id, entry, name, provider, label: `${name} (${provider})` };
    })
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

/**
 * Flat, searchable single-list model picker.
 *
 * One navigation axis: ↑/↓ move the cursor (PgUp/PgDn page), typing fuzzy-filters across every
 * provider (provider name included), and ←/→ step the thinking level for models that reason.
 */
export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  /** Per-model thinking-level override set by ←/→; absent → the default. */
  private readonly thinkingOverrides = new Map<string, ThinkingLevel>();

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.id === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  /** Level for a model: an explicit ←/→ override, the live level for the active model, else the session's. */
  private levelFor(choice: ModelChoice): ThinkingLevel | undefined {
    const levels = thinkingLevelsFor(choice.entry);
    if (levels.length === 0) return undefined;
    const override = this.thinkingOverrides.get(choice.id);
    if (override !== undefined) return override;
    return this.opts.currentThinkingLevel;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (this.list.handleKey(data)) return;

    if (this.opts.thinkingControl !== false && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      const selected = this.selectedChoice();
      if (selected !== undefined) {
        const levels = thinkingLevelsFor(selected.entry);
        if (levels.length > 1) {
          const current = this.levelFor(selected);
          const idx = current === undefined ? 0 : Math.max(0, levels.indexOf(current));
          const delta = matchesKey(data, Key.left) ? -1 : 1;
          const next = Math.max(0, Math.min(levels.length - 1, idx + delta));
          if (next !== idx) this.thinkingOverrides.set(selected.id, levels[next]!);
        }
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedChoice();
      if (selected === undefined) return;
      this.opts.onSelect({ id: selected.id, thinking: this.levelFor(selected) });
    }
  }

  override render(width: number): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;

    const titleSuffix = searchable && view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';

    const hintParts: string[] = ['↑↓ navigate'];
    if (searchable && view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select', 'Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', this.opts.title ?? ' Select a model') + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
    ];
    if (this.opts.warning !== undefined) {
      for (const line of wrapTextWithAnsi(this.opts.warning, Math.max(1, width - 1))) {
        lines.push(currentTheme.fg('warning', ` ${line}`));
      }
    }
    lines.push('');

    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    } else {
      const nameCap = Math.max(8, Math.floor(width * 0.5));
      let nameWidth = 0;
      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(choice.name));
      }
      nameWidth = Math.min(nameWidth, nameCap);

      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const isCurrent = choice.id === this.opts.currentValue;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
        const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
        let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        line += (isSelected ? currentTheme.boldFg('primary', truncatedName) : currentTheme.fg('text', truncatedName)) + namePad;
        line += '  ' + currentTheme.fg('textMuted', choice.provider);
        if (isCurrent) line += ' ' + currentTheme.fg('success', CURRENT_MARK);
        lines.push(line);
      }
    }

    if (view.query.length > 0) {
      lines.push('');
      lines.push(currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalCount)}`));
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    const selected = this.selectedChoice();
    if (selected !== undefined && this.opts.thinkingControl !== false) {
      const levels = thinkingLevelsFor(selected.entry);
      lines.push(currentTheme.fg('textMuted', levels.length > 1 ? ' Thinking  (←→ to switch)' : ' Thinking'));
      lines.push(this.renderThinkingControl(selected));
      lines.push('');
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  private renderThinkingControl(choice: ModelChoice): string {
    const levels = thinkingLevelsFor(choice.entry);
    if (levels.length === 0) {
      // The whole segment is muted so an unsupported control reads as greyed out, not selectable.
      return `  ${currentTheme.fg('textMuted', '  Unsupported  ')}`;
    }
    const active = this.levelFor(choice);
    const rendered = levels.map((level) =>
      level === active
        ? currentTheme.boldFg('primary', `[ ${thinkingLabel(level)} ]`)
        : currentTheme.fg('text', `  ${thinkingLabel(level)}  `),
    );
    return `  ${rendered.join(' ')}`;
  }
}
