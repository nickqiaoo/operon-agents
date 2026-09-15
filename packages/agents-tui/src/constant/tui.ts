export { PRODUCT_NAME } from '../app/constant/app.ts';

export const NO_ACTIVE_SESSION_MESSAGE = 'No active session.';
export const CTRL_D_HINT = 'Press Ctrl+D again to exit';
export const CTRL_C_HINT = 'Press Ctrl+C again to exit';
/** The root agent's conversation address (`AgentEvent.address` of the main agent). */
export const MAIN_AGENT_ID = 'main';
export const EXIT_CONFIRM_WINDOW_MS = 1500;
/** Session picker page size (client-side paging over `harness.listSessions`). */
export const SESSION_LIST_PAGE_SIZE = 50;

/**
 * Window in which two Esc presses count as a double-Esc. Kept short (double-click feel) so two
 * deliberate presses far apart do not trigger the shortcut.
 */
export const DOUBLE_ESC_WINDOW_MS = 600;
export const NO_MODEL_MESSAGE = 'No model set. Start with --model provider/model, or pick one with /model.';
