---
"@promptowl/contextnest-community": patch
---

Public docs site fixes:

- Verifying a custom domain or public URL no longer hangs on a slow DNS server. The lookup gives up after about 5 seconds and says it timed out, and the daily re-check does the same without un-verifying the domain.
- Large docs sites use much less server memory. Each page now carries one copy of the page list instead of two (it still shows as a sidebar on desktop and a "Contents" dropdown on phones), and the server keeps at most about 256 MB of built sites in memory, dropping the least recently used first.
- Two nests with the same name turning on their public site at the same moment no longer fail with a server error; the second one gets its own id as its URL. A nest can no longer take another nest's id as its URL by being named after it.
- API.md now states that glossary definitions on the public docs site are not approval-gated: an editor's definition is public as soon as it is saved, as it already is in the public reader.
- The Markdown copy of each page (`.md` and `llms-full.txt`) no longer shows the path of a linked draft or missing document. Links are handled as on the HTML page: a link to a published page points at its URL, and any other link keeps only its label. Code samples are left as written.
- A custom docs domain sent with a trailing dot (`docs.example.com.`) is served, not answered with "not found". A `.md` request that follows a redirect now gets a valid URL when the target has a `#section` or query. The server warns at startup when `DOCS_SITES` is set without `PUBLIC_BASE_URL`, because it can't then tell whether an entry is the server's own host.
