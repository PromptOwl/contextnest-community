---
"@promptowl/contextnest-community": minor
---

**A refused edit now offers to request access instead of stopping there.** When someone who can read a document or nest tries to change it, they're asked "Request edit access?" with room for a note, and anything they haven't saved stays where it is. The nest owner and admins get the request in My Work (plus email and nest channels) and approve or deny it in one click; approving gives the access through the normal sharing paths (a write share on the document or folder, or nest write), and the requester is told either way. Asking twice shows "Request pending" rather than a second request, and a denied request shows who said no and why, with the option to ask again. Viewers also get a **Request edit access** button on documents and on the nest page. Nests you can't see still answer "not found", with no offer.

Agents get the same flow over MCP: a refused `context_create` / `context_update` / `context_delete` / `context_move` names `context_request_access` and carries `can_request_access`, the target and the level in its structured result; `context_access_requests` and `context_resolve_access_request` let an owner or admin decide. Over REST the 403 body carries `can_request_access`, `target` and `level`, and `POST /nests/:id/access-requests` files the ask (see API.md).

Also fixed: a nest viewer who had been given a write share on a document still couldn't edit it — the share was ignored for anyone with nest read access. It now counts on that document's write routes, over REST and MCP.
