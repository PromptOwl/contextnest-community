---
"@promptowl/contextnest-community": patch
---

`contextnest://` links are graph edges, and a selector's `hops` actually expands

`POST /nests/:id/context` hop expansion and the ontology graph (`GET /nests/:id/graph`) only followed `[[wikilinks]]`. A node linked with the spec's own link form, `[text](contextnest://nodes/…)`, was never returned at any `hops`, and never drawn as an edge, while a `[[wikilink]]` at the same distance was. Both now follow `contextnest://` links, including pinned and anchored forms (`contextnest://nodes/foo@3#bar` links to `nodes/foo`). The target is matched by id only, so a dangling link draws nothing and can't attach to an unrelated node that happens to share its slug. Links quoted in inline code or fenced code blocks are ignored.

An explicit engine `selector` now honours `hops` as documented. Before, the engine ran in full mode, which ignores `hops`, so only `[[Title]]` selector parts were ever expanded. `hops: 0` results are unchanged. A selector request that omits `hops` gets the documented default of 2, so linked neighbours now come back where they previously did not.
