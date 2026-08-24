export type ManagedErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "internal_error";

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
    super(404, "not_found", `session "${sessionId}" not found`);
    this.name = "ManagedSessionNotFoundError";
    this.sessionId = sessionId;
  }
}

export class ManagedConflictError extends ManagedServerError {
  constructor(message: string) {
    super(409, "conflict", message);
    this.name = "ManagedConflictError";
  }
}

export class ManagedInvalidRequestError extends ManagedServerError {
  constructor(message: string) {
    super(400, "invalid_request", message);
    this.name = "ManagedInvalidRequestError";
  }
}

export class ManagedUnauthorizedError extends ManagedServerError {
  constructor(message = "authentication required") {
    super(401, "unauthorized", message);
    this.name = "ManagedUnauthorizedError";
  }
}

export class ManagedForbiddenError extends ManagedServerError {
  constructor(message = "request is not authorized") {
    super(403, "forbidden", message);
    this.name = "ManagedForbiddenError";
  }
}
