import type { ManagedApiError } from "../protocol/types.ts";

export class ManagedApiClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message);
    this.name = "ManagedApiClientError";
    this.status = status;
    this.code = code;
  }
}

export async function throwApiError(response: Response): Promise<never> {
  let body: ManagedApiError | undefined;
  try {
    body = await response.json() as ManagedApiError;
  } catch {
    // Fall through to HTTP status text.
  }
  throw new ManagedApiClientError(
    body?.error.message ?? `${response.status} ${response.statusText}`,
    response.status,
    body?.error.code,
  );
}
