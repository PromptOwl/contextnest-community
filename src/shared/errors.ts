export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
    this.name = "ValidationError";
  }
}

/** The upload is bigger than this server accepts for its kind (413). */
export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, message);
    this.name = "PayloadTooLargeError";
  }
}

/** A role change would take the server past its pricing plan (402). */
export class PlanLimitError extends AppError {
  constructor(
    public limit: "users" | "subscribers" | "account_owners",
    public max: number,
    message: string,
  ) {
    super(402, message);
    this.name = "PlanLimitError";
  }
}

/** A role change raises someone's billed class and wasn't confirmed (409). */
export class BillingConfirmError extends AppError {
  constructor(
    public changes: Array<{ userId: string | null; email: string | null; from: string; to: string }>,
  ) {
    super(409, "This change raises what someone is billed. Confirm it to continue.");
    this.name = "BillingConfirmError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
    this.name = "ConflictError";
  }
}

/**
 * An error whose JSON body carries a machine-readable `code` (and optional
 * extra fields / headers), for APIs agents parse: the agent event API's
 * `idempotency_conflict` (409), schema violations naming the field (422) and
 * `rate_limited` (429 + Retry-After). Rendered by app.onError.
 */
export class CodedError extends AppError {
  constructor(
    statusCode: number,
    message: string,
    public code: string,
    public extra: Record<string, unknown> = {},
    public headers: Record<string, string> = {},
  ) {
    super(statusCode, message);
    this.name = "CodedError";
  }
}

/**
 * The write would land as a draft for a reviewer, and the caller asked for
 * publish-or-nothing (WriteOptions.publishOnly — bulk board edits). 409: the
 * document's governance, not the request, is what stands in the way.
 */
export class ReviewRequiredError extends AppError {
  constructor(message: string) {
    super(409, message);
    this.name = "ReviewRequiredError";
  }
}

export class LockedError extends AppError {
  constructor(message = "Locked") {
    super(423, message);
    this.name = "LockedError";
  }
}

/**
 * The engine's per-vault write lock could not be acquired — a concurrent
 * writer held it past the acquire timeout (normally a wedged process; the
 * critical section is milliseconds). Retryable by design: surfaced as
 * 503 + Retry-After, never a 500. Distinct from LockedError (423), which is
 * the steward-review lock on a document.
 */
export class VaultBusyError extends AppError {
  retryAfterSeconds = 5;
  constructor(message = "The vault is busy with another write. Retry shortly.") {
    super(503, message);
    this.name = "VaultBusyError";
  }
}

/**
 * Detects the engine's VaultLockTimeoutError by name/code rather than
 * instanceof: matching survives the dual CJS/ESM package boundary, and works
 * (as a no-op) against engine versions that predate the vault lock.
 */
export function isVaultLockTimeout(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return e?.name === "VaultLockTimeoutError" || e?.code === "VAULT_LOCK_TIMEOUT";
}
