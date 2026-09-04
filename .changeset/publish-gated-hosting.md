---
"@promptowl/contextnest-community": minor
---

Publish: host one document as a standalone page at a gated `/p/<slug>` link.

A **Publish** action on any document (owner/admin, from the document menu or the
editor) mints a stable, unguessable link that serves that document full-screen
to people with no account. Distinct from nest visibility, which opens a whole
nest, and from grants, which share with an authenticated user: a publish exposes
exactly one node and no other, and the public surface is mounted outside the
`/nests` auth chain so no node API is reachable from it.

Four gates. **Public** serves immediately. **Passcode** takes one shared code —
bcrypt-hashed, because a human-chosen secret gets the password treatment rather
than the fast hash reserved for high-entropy tokens — with a show/hide toggle on
the field, since a code read off a slide is easy to mistype. **Email** and
**invite** mail a one-time link; invite additionally holds an allow-list. Both
issue an `HttpOnly` session cookie scoped to `Path=/p/<slug>`, so clearing one
link's gate never opens another.

**Only the approved version is ever served.** The page reads through the same
snapshot reader the hosted artifact viewer uses, so an in-progress edit does not
reach the open web the moment it is saved, and a document that has never been
approved 404s rather than exposing its draft. That is the point of publishing
from a governance product rather than a file host.

Per-link overlays: **expiry** and **revoke** (both enforced on every route, so
revoking kills live sessions, not just new ones), **watermark**, which stamps
the viewer's email across the page, and **no-download**, which blocks copy,
cut, right-click, drag, printing and the save/print/copy/view-source shortcuts.
Those last two are deterrents and are labelled as such in the UI: the document
has already been delivered to the reader's machine, so screenshots, developer
tools and `curl` still return it. Watermarking is a no-op on the public and
passcode gates, which identify nobody — attribution is the lever that actually
deters, which is why it needs an identified viewer.

**Comments**, per link. A reader opens a modal on the page itself and posts
without navigating away; the comment lands as an unanchored annotation thread on
the document, in the same list stewards already read, and never renders on the
published page. Every comment carries an identifying email — the gated viewer's
where one exists, otherwise one they supply, which is self-asserted on public and
passcode links. Because the document runs under the artifact sandbox, which
blocks forms and network calls and propagates those restrictions to any popup it
opens, the comment UI cannot live inside it: the page frames the document in a
same-origin iframe and keeps the controls on the outer shell, leaving the
document's sandbox intact.

Markdown documents are rendered server-side, so a published note reads like the
editor instead of showing its own `##` and `**` source.

On the security posture: slugs are 64 bits of randomness behind a unique index;
magic-link tokens are single-use, stored hashed, and re-checked against the
allow-list when redeemed rather than only when sent; the gate answers an invited
and an uninvited address with the same page *and* the same database work, so it
cannot be timed into an allow-list oracle; the gate is rate limited per link per
IP; and a revoked, expired or unknown slug all produce one identical notice,
which never confirms that a given slug was real.

Email and invite links are refused on a server with no mail transport
configured, and the dialog disables those two gates, because their only way in
is a link that could never be sent. **Set `PUBLIC_BASE_URL` on any deployment
using them** — unset, the mailed link is built from the request's `Host`, so a
proxy forwarding an attacker-supplied host would send the recipient a one-time
access token pointing somewhere else.

Every served view is logged with the viewer's email where the gate identifies
one, visible to the owner in the dialog's "who viewed" panel.
