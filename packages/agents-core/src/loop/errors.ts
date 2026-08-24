export class MaxStepsExceededError extends Error {
  readonly maxSteps: number;
  constructor(maxSteps: number) {
    super(`max steps exceeded: ${maxSteps}`);
    this.name = "MaxStepsExceededError";
    this.maxSteps = maxSteps;
  }
}

export function isMaxStepsExceededError(error: unknown): error is MaxStepsExceededError {
  return error instanceof MaxStepsExceededError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
