---
"@promptowl/contextnest-community": minor
---

The navigation bar color is configurable (PO-1430). A server admin picks it in Server settings → Basic → Navigation color: a small palette, a custom hex, and a live preview. Text, icon, hover and border colors follow automatically and stay readable (WCAG AA), light colors included. Unset, the rail stays navy. Agents read it with `context_appearance` and admins set it with `context_appearance_update` on the server-level `/mcp`; over REST it is `nav_color` on `GET /health` and `PATCH /admin/settings` (`NAV_COLOR` in the deploy env).
