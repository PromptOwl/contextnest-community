---
"@promptowl/contextnest-community": minor
---

Pick up the engine's per-vault write lock, and retire the last legacy write path.

Engine 2.4.0 ships a cross-process write lock (PromptOwl/ContextNest#78): every
mutation through the operation catalog serializes on it, and a writer that cannot
acquire it within 20s fails with `VaultLockTimeoutError`. The engine pin moves to
`^2.4.0` to take it. Two things had to be true here before that upgrade was safe:

**Every wire surface now maps the lock timeout to a retryable error.** REST
returns `503` with a `Retry-After` header (via a new `VaultBusyError`); MCP
returns an `isError` tool result whose `structuredContent` carries
`code: "VAULT_BUSY"` — never a generic 500. Detection matches the error by
`name`/`code` rather than `instanceof`, so it survives the package boundary —
and, because it keys on the error rather than the class, it was already correct
against the engine versions that predate the lock.

**`POST /nests/:nestId/publish` no longer writes documents by hand.** It was the
last pre-catalog write path — hand-built frontmatter, its own slugify, direct
`writeDocument` — invisible to any engine-side locking. It now routes each
document through the same `createNode` path as every other create surface.
One behavior change: a document whose title slugs to an **existing id is skipped
and reported** in a new additive `skipped` response field, instead of silently
overwriting the existing document and restarting its version history.

Going through `createNode` also means a single document can now be refused on its
own merits — an unusable title, a type the engine does not know. The batch is not
a transaction, so a row that fails is reported in a new additive `failed` field
and the remaining documents still publish, rather than aborting the batch and
leaving the earlier writes on disk with nothing in the response naming them. The
one error that still stops the batch is the lock timeout itself: it answers `503`,
and retrying is safe because everything the first attempt created comes back under
`skipped`.

One gap stays open on purpose: the `context_md` half of that same endpoint has
no operation in the catalog to route through, so it remains a direct write and
will not be covered by the lock. It cannot answer a retryable `503` either —
there is no timeout to map. Closing that needs an engine-side op for
`CONTEXT.md`, which is Phase B work.

Also removed the dead `safePublishDocument` wrapper, and added the
concurrent-writes regression for the MCP surface (the REST surface already had
one): a burst of concurrent `context_update` calls must land as a contiguous,
duplicate-free, fully reconstructable version history with nothing staged by a
drift scan.
