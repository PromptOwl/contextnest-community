---
"@promptowl/contextnest-community": minor
---

Add the `org` nest visibility tier — readable by everyone signed in to this deployment.

**The missing middle.** Nest visibility was `private` or `public`, so sharing a nest company-wide meant adding every person as a collaborator or opening it to the internet. `org` is the tier in between: any authenticated user of this deployment can read it; anonymous callers still get nothing. Community has no tenant model and teams are a group you *attach* to a nest rather than an org boundary — a self-hosted install already IS one organization, so deployment membership is the boundary. `PATCH /nests/:id/visibility` accepts `org`, and unlike `public` it needs no `acknowledge_public`: it crosses no organizational boundary. Like public readers, org readers see approved content only.

**Discovery follows access.** An org nest joins the readable union and the discovery listing for an authenticated caller, and neither for anon — an org nest nobody could find would be reachable only by a passed-around link, which is not what "available to the organization" means.

**The migration rebuilds `nests`, carefully.** SQLite cannot alter a CHECK constraint in place, and `nests` is the most-referenced table in the schema: 27 tables point at `nests(id)`, every one `ON DELETE CASCADE`, on a connection that runs `foreign_keys = ON`. A plain `DROP TABLE` would take every node-index row, version, steward, grant and run with it — verified, not theorised: with the pragma left on, a control run deleted every child row. So `038_nest_visibility_org` toggles `foreign_keys` **outside** the transaction (the pragma is a no-op inside one), derives the replacement table from the live schema rather than a hardcoded column list (other branches add columns to `nests`, and a stale list drops them silently), and refuses to record itself unless `PRAGMA foreign_key_check` comes back clean. Postgres needs none of it — its constraint swap is catalogue-only.

**The UI reports the tier rather than lying about it.** Nothing in the UI *sets* `org` yet, but the API accepts it, so the visibility control and the nest header now read the visibility string instead of a boolean: an org nest shows "Organization" and says everyone signed in to the deployment can read it. Previously anything that was not literally `public` rendered as "Private — only people added below can see this nest," which for an org nest told the owner the opposite of the truth.
