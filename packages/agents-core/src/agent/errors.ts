/** The session is closed: nothing can be sent to it or run on it. */
export class SessionClosedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session "${sessionId}" is closed`);
    this.name = "SessionClosedError";
    this.sessionId = sessionId;
  }
}

/** The session is waiting for an answer to an interrupted run, and nothing else can go in first. */
export class SessionInterruptedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session "${sessionId}" has an interrupted run. Respond to it or resolve it before sending anything else.`);
    this.name = "SessionInterruptedError";
    this.sessionId = sessionId;
  }
}

/** An answer was given, but the session has no interrupted run to apply it to. */
export class SessionNotInterruptedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`No interrupted run to respond to on session "${sessionId}" (no persisted interruption state).`);
    this.name = "SessionNotInterruptedError";
    this.sessionId = sessionId;
  }
}

/** No frame is running at the address a message was sent to. */
export class SteerTargetNotFoundError extends Error {
  readonly sessionId: string;
  readonly address: string;

  constructor(sessionId: string, address: string) {
    super(`no frame is running at "${address}" in session "${sessionId}"`);
    this.name = "SteerTargetNotFoundError";
    this.sessionId = sessionId;
    this.address = address;
  }
}
