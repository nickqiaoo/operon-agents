/** Anthropic-style error types, carried as `error.type` in the response body. */
export type ManagedErrorCode =
  | "invalid_request_error"
  | "not_found_error"
  | "conflict_error"
  | "authentication_error"
  | "permission_error"
  | "api_error";

export class ManagedServerError extends Error {
  readonly status: number;
  readonly code: ManagedErrorCode;

  constructor(status: number, code: ManagedErrorCode, message: string) {
    super(message);
    this.name = "ManagedServerError";
    this.status = status;
    this.code = code;
  }
}

export class ManagedSessionNotFoundError extends ManagedServerError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(404, "not_found_error", `session "${sessionId}" not found`);
    this.name = "ManagedSessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export class ManagedConflictError extends ManagedServerError {
  constructor(message: string) {
    super(409, "conflict_error", message);
    this.name = "ManagedConflictError";
  }
}

export class ManagedInvalidRequestError extends ManagedServerError {
  constructor(message: string) {
    super(400, "invalid_request_error", message);
    this.name = "ManagedInvalidRequestError";
  }
}

export class ManagedUnauthorizedError extends ManagedServerError {
  constructor(message = "authentication required") {
    super(401, "authentication_error", message);
    this.name = "ManagedUnauthorizedError";
  }
}

export class ManagedForbiddenError extends ManagedServerError {
  constructor(message = "request is not authorized") {
    super(403, "permission_error", message);
    this.name = "ManagedForbiddenError";
  }
}
