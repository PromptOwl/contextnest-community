---
"@promptowl/contextnest-community": patch
---

Copy buttons work on Mac Safari (and iOS) as well as Windows. Every copy button in the app is now one shared `CopyButton` component, so they all copy the same way and show the same "Copied" check. When the browser's clipboard API is missing or refuses, the fallback copy now runs inside the open dialog, so the dialog's focus trap no longer empties it, and it selects text the way iOS needs. On published sites, "Copy page" starts the clipboard write on the click itself, which Safari requires, instead of after the page's markdown has downloaded. Five buttons that called the clipboard directly (publish links, push nest id, DNS records, structure YAML, the `ctx setup` command) now get the fallback and an error toast too.
