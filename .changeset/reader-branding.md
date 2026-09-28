---
"@promptowl/contextnest-community": minor
---

Per-nest branding for public reader sites.

A nest owner or admin can now brand what readers see — the reader-mode docs site
and the nest's `/p` published links: a **logo**, a **banner** (image and/or
headline + subtext, shown on the home page), an **accent color** (links, the
current page, buttons), a **header background color**, an optional **page tint**,
a **site title**, **footer text + link**, and an optional **favicon**. Open it
from the nest's **Reader** button → **Branding → Customize**; the dialog has a
live preview.

Colors are strict `#rgb` / `#rrggbb` and applied as CSS custom properties. Text
on any color is picked automatically (black or white, whichever meets WCAG AA
4.5:1), and the accent used as link text is deepened until it reads at 4.5:1 on
the page. Images are uploaded nest assets (PNG/JPG/GIF/WebP — SVG stays
excluded) or `https://` image links.

On `/p` the CSP is unchanged: uploaded images are inlined as `data:` images
(already allowed); external https images are not shown there. HTML/artifact
publishes are the author's own page and are not wrapped.

`PATCH /nests/:id/branding` (owner / nest admin / server admin) replaces the
branding; `null` or `{}` resets it. Hiding "Powered by ContextNest" / "Secured by
PromptOwl" is server-admin only. `GET /nests/:id` returns the parsed
`nest.branding` (null when unbranded). Nests with no branding render exactly as
before; the server-wide `LOGO_URL` still brands the app shell and is the logo
fallback for a branded reader.
