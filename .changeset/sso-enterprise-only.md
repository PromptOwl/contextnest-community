---
"@promptowl/contextnest-community": minor
---

Enterprise single sign-on is Enterprise only; Google sign-in stays on every plan.

- **New licence feature `sso`.** Included with Enterprise. Without it, Settings won't switch SSO to Entra ID, Okta or another custom OIDC issuer, or turn one on — `PATCH /admin/settings` answers `403 { code: "sso_required" }` and writes nothing. The Google preset works on every plan.
- **No lockouts.** A server already signing in through an enterprise provider keeps working; only changing it, or turning SSO back on after turning it off, needs Enterprise.
- **Settings → Single sign-on** splits into a **Google sign-in** card (every plan) and an **Enterprise single sign-on** card (Entra ID tenant or any issuer URL), locked as a whole without `sso`. `GET /admin/settings` returns `sso_available`.
- **Docs** (README, LICENSING, CONFIGURATION) list which features every plan gets and which need Enterprise; Enterprise features are on by default with an Enterprise key.
