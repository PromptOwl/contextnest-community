---
"@promptowl/contextnest-community": minor
---

New **Server settings → Network & status** tab for admins running a self-hosted server behind a firewall, VPN, proxy or tunnel:

- **Server status checklist**: database, migrations, disk, nest storage, license, public address, email, SSO, workflow scheduler and version. Every amber or red item says how to fix it. The migration check also warns when a newer version has already migrated the database (a rolled-back image).
- **Reachability**: checks the public address from this server, and tests every outbound host the server calls (DNS → TCP → TLS → HTTP) with a copyable allowlist. HTTPS goes through the egress proxy exactly when the server's own traffic does, honouring `NO_PROXY`. If a proxy is configured but Node isn't using it, the tab says why. Also checks OIDC discovery and clock skew.
- **Deployment guide** with copyable recipes for public HTTPS, reverse proxy, VPN-only, NAT, tunnels and corporate egress proxy, plus a Microsoft Entra ID sign-in walkthrough.
- The probes are admin-only and rate-limited. Their targets come only from server configuration, and no secret appears in any response.
