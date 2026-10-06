---
"@promptowl/contextnest-community": minor
---

**Licensing is now a private conversation with the admin, not something the whole team runs into.**

**Seats are reported to PromptOwl, never enforced.** Every license check (startup plus every 60s) now sends the server's user and nest counts, its version and `PUBLIC_BASE_URL` alongside the key. That is the head-count the license is billed on, and PromptOwl uses it to follow up about seats. It is part of validation, so it is sent even with `TELEMETRY_ENABLED=false`, and it never carries content. Going over the licensed seats blocks nobody. The admin sees a friendly note ("You have 34 people on a 30-seat license. Everyone can keep working…").

**A lapsed license makes the server read-only instead of locking everyone out.** Before, a revoked or deactivated key wiped every session, deleted the stored key, and sent everyone, admins included, to the activation screen. Now, when PromptOwl confirms a lapse (3 consecutive rejections, a confirmed suspension, or the end of the 14-day expiry grace), writes stop but reads keep working, nobody is signed out, and the key stays installed, so a renewal or reactivation on PromptOwl's side restores the server on the next check. The activation screen is only for a server that has never been licensed (`/license/status` → `setup_required`).

**Who hears what.** Server admins, and the key's owner even after it lapsed, get specifics: trial days left, when an expired license's grace period ends, seats in use, a key PromptOwl is refusing, each with a "Talk to PromptOwl" button and email. Everyone else never sees licensing vocabulary, and sees anything at all only once the workspace is actually read-only: "This workspace is read-only right now. Your administrator has been notified." The same split applies to the 503 bodies from the license gate, the server `/mcp` write tools and run writes.

- New **Settings → License** tab: plan, seats used/licensed, end date and grace, last check with PromptOwl, install a replacement key, and how to reach PromptOwl.
- New **admin license banner**, never red. Admins can hide it for a week, except within 3 days of anything changing.
- New `GET /admin/license` (server admin or key owner) with the full detail. `GET /license/status` stays public and carries none of it.
- `POST /license/install` is public only until the server has a license owner. After that, replacing the key takes the owner or a server admin, so a lapsed license can't be claimed by pasting another key.
