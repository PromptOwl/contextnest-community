---
"@promptowl/contextnest-community": minor
---

Hand folder import to the engine, and upload it in batches instead of a stream.

Importing a folder failed with a bare "Import failed" and no reason, and spent a
long time apparently doing nothing before it started. Three separate causes.

**The failures had nowhere to surface.** Import streamed NDJSON progress over
`POST /nests/import?stream=1`, which commits HTTP 200 *before* any of the work
runs. Every real failure therefore arrived as a successful response carrying an
error line the client often never reached, and a buffering proxy would swallow
the progress lines the stream existed to deliver in the first place. The
streaming endpoint is gone. The upload now goes up in ~4MB chunks as ordinary
JSON requests, each with a real status code and a real message — which also
keeps a large folder under the request-size limits a single body was hitting.
`registerImportedDocuments` used to `return 0` when the vault scan failed, which
reported a broken vault as a successful import of an empty folder; it now
throws.

**The server did the engine's job, twice.** Import scanned the vault itself, then
rewrote every document to stamp the importing user as `author`, and only then
asked the engine to publish — which rewrites each document again. On a
Cloud Storage mount that is two extra network round trips per document before
publishing has even started. The engine's `context_import` now owns the whole
flow: the community server writes nothing to the vault, it hands files to the
engine (`files[]`), stages each chunk without publishing, and makes one
`discover` call at the end that scans, stamps, publishes under a single
checkpoint and returns the per-document detail needed for governance rows.

**The browser read files one at a time.** Scanning a picked folder awaited each
`file.text()` in sequence, which is the delay users saw *before* an import
appeared to begin. Reads are now batched, and sibling directories are walked in
parallel.

**Importing a folder no longer publishes documents that never asked to be
published.** Previously a file with no `status:` in its frontmatter — an
ordinary hand-authored note — was published on import and became AI-visible.
Now only files that explicitly say `published` or `approved` are published;
everything else is imported as a draft and waits for a human to approve it,
with `status: draft` written down rather than left implied. Importing a plain
Obsidian vault therefore yields drafts, not a published nest. Nests exported
from ContextNest are unaffected: their documents carry an explicit status, so a
round-trip still comes back published.

Two further behaviours worth calling out:

- An imported vault's `.versions/` history is preserved. A document whose
  version chain will not reconstruct now registers as a draft with its history
  intact, instead of having that history deleted so it could be republished from
  a fresh keyframe.
- A failed upload deletes the half-filled nest rather than leaving it on the
  dashboard with silently missing documents.

Requires `@promptowl/contextnest-engine` with the `files[]` / `publish` /
`discover` inputs on `context_import`.
