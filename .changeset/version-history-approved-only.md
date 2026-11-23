---
"@promptowl/contextnest-community": patch
---

Version history now follows the approved-content rule for readers who are not members (po-1465). Someone who reaches a nest only because it is public or org-visible sees a document's approved versions in `GET …/versions`, `GET …/versions/:version`, `GET …/hosted?v=N` and MCP `context_versions`, plus their own draft. Asking for any other version answers 404. Editor and reviewer identities are no longer returned to those readers, to headless keys or to read-only keys. Members see every version, as before.
