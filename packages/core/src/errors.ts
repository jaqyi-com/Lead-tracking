/** Errors that the API maps to 4xx responses with a plain-language message. */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super("not_found", `${what} not found`, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You don't have access to this") {
    super("forbidden", message, 403);
  }
}

export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
    public raw?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
