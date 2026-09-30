---
"@promptowl/contextnest-community": minor
---

Hootie in the nest is now a side panel instead of a chat bubble, off by default, and Enterprise licences can rename and brand it.

This reverses the 1.27.0 choice of a corner chat window over a full-height slide-over. The assistant opens from a slim tab on the right edge and slides in beside the page. On screens 1280px and wider it pushes the page over rather than covering it; on narrower screens it overlays. Drag its left edge (or use the arrow keys on the handle) to resize it between 340px and 720px; the width is remembered per browser, and a double-click resets it. Closing it keeps the conversation, as before.

**Behaviour change:** `HOOTIE_ENABLED` now defaults to off. A server that had Hootie on only because it was the default will find it off after upgrading. Turn it on under Settings → General or with `HOOTIE_ENABLED=true`. A server that set `HOOTIE_ENABLED=true` in its deploy environment, or turned it off in Settings, keeps that choice. Both states are now written explicitly from Settings, so a UI choice beats the deploy env either way. The startup banner prints whether Hootie is on.

**Custom identity (Enterprise):** admins set the assistant's name, logo (an https image link), accent colour (hex) and greeting under Settings → General, or with `HOOTIE_NAME`, `HOOTIE_LOGO_URL`, `HOOTIE_ACCENT_COLOR` and `HOOTIE_GREETING`. The identity shows on the edge tab, the panel header, next to each answer and in the greeting, and the name also goes into the assistant's system prompt and the comments it posts for @mentions. `/health` reports the identity to show as `hootie_brand`, decided on the server. Without an Enterprise licence (tier `enterprise`, valid and not suspended), `/admin/settings` refuses a request that would change any branding field with `403 enterprise_required` and writes nothing from it (sending back the stored values unchanged is allowed), and every surface shows the default Hootie. A licence that lapses reverts to Hootie on the next request without deleting the stored values.
