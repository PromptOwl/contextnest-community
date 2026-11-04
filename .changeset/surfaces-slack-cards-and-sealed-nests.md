---
"@promptowl/contextnest-community": minor
---

**Surfaces for Slack: approve in Slack, credited to you, plus private nests.**
- **Approve, edit or reject in Slack.** Proposals arrive as cards in the thread they came from. Approve, Edit or Reject commits through the review queue as the person who clicked, never as the bot, with a one-time "Is that you?" check on first use. Reviewers get a "My pending" tab in the Slack App Home, plus per-reviewer daily limits, a queue and expiry.
- **When the channel can't read the nest.** Cards show a fixed sentence and never nest text. Cards already posted are redacted if that changes.
- **Leaving and returning.** Anyone can remove Nest from a conversation (`/nest leave`), except in general channels, and members can invite it back (`/nest invite`).
- **Private DM nests.** DM capture is off by default and has a personal opt-out. DMs go to a sealed private nest: only the owner can open or review it, and server admins see only that it exists and can delete it.
- **Owner alerts.** Owners are alerted on new sign-ins and when admins change sign-in or email settings. API.md documents the limits.
