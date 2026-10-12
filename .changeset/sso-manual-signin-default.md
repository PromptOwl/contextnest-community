---
"@promptowl/contextnest-community": minor
---

With single sign-on (OIDC) on and configured, `MANUAL_SIGN_IN` now defaults to `invite-only` instead of `open`. Everyone the identity provider vouches for already gets in through SSO, and an open password door let anyone create an account the IdP never sees and can't disable. An explicit `MANUAL_SIGN_IN=open` still works, but the server logs a startup warning, `/admin/settings` reports `manual_sign_in_open_with_sso: true`, and the Settings page shows a warning. While `OIDC_ALLOWED_DOMAINS` is set, password self-registration is limited to those domains as well. Servers without SSO are unchanged.
