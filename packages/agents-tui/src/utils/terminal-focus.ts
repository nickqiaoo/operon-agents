import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '../constant/terminal.ts';
import type { TUIState } from '../tui-state.ts';
import type { TerminalState } from './terminal-state.ts';

export {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '../constant/terminal.ts';

export function installTerminalFocusTracking(state: TUIState): () => void {
  state.terminalState.focused = true;
  const disposeInputListener = state.ui.addInputListener((data) =>
    handleTerminalFocusInput(state.terminalState, data),
  );
  state.terminal.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    state.terminalState.focused = true;
  };
}

export function handleTerminalFocusInput(
  state: Pick<TerminalState, 'focused'>,
  data: string,
): { consume: true } | undefined {
  if (data === TERMINAL_FOCUS_IN) {
    state.focused = true;
    return { consume: true };
  }
  if (data === TERMINAL_FOCUS_OUT) {
    state.focused = false;
    return { consume: true };
  }
  return undefined;
}
