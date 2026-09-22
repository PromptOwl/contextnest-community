---
"@promptowl/contextnest-community": minor
---

Opening a nest to the Organization tier on a shared server now asks first — and says who it really reaches. Plus a "My nests" dashboard default.

A nest's **Organization** visibility means every authenticated account on this deployment. On a self-hosted server that is your company, so the tier flipped in one click with the hint "everyone signed in here can read". On the PromptOwl-hosted service one server holds many unrelated customers, so the same click made a nest readable by every one of them — under a label that sounded like "my organisation". Only **Public** confirmed.

**A superadmin toggle names what the server is.** Settings → General → *This server hosts several organisations* (`SHARED_DEPLOYMENT`, off by default, persisted like every other runtime setting, reported on `GET /health`). With it on, choosing Organization asks for the same acknowledgement Public does — and the server enforces it: `PATCH /nests/:id/visibility` to `org` without `acknowledge_public: true` returns `409 requires_acknowledgement`, so an API or MCP caller can't skip it either. The picker's hints and both dialogs then say the literal boundary: "every account on this server — other organisations included", and Public adds "including every account on this server". Off, nothing changes for a self-hosted install.

**The dialog shows what strangers will see.** The confirmation displays the nest's description — that and the name are all a reader discovering the nest gets — and offers to write one when it is empty. Optional; it never blocks the change.

**Your nests first.** The dashboard opens on a new **My nests** scope (owned or shared with you) instead of everything you can read, so other people's org/public nests are a choice — *Organization*, *Public* or *All nests* in the same select — rather than the first screen. The choice is remembered per browser. `GET /nests` rows now carry `discovered: true` for nests reached through visibility alone. A newcomer with nothing of their own sees "No nests of your own yet" with a *Browse all nests* button, not "hidden by the current filter".
