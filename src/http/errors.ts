import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.retryAfter !== undefined
        ? { retry_after: this.retryAfter }
        : {}),
    };
  }
}

export function databaseOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      "unavailable",
      "Database operation failed.",
      "Wait 5 seconds and retry. Contact the operator if it persists.",
      5,
    );
  }
}
