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

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
    this.name = "ConflictError";
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
