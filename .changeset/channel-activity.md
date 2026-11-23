---
"@promptowl/contextnest-community": patch
---

Control room → Setup → Choose channels: a bound channel's Manage menu has an **Activity** view (po-1446) that answers "why no card?" for the last 7 days, in plain words: messages received, kept for judging and skipped (with each reason: too short, from bots, from guests, said skip me…), threads waiting for the quiet window, threads judged (proposed, nothing worth keeping, failed; the Decision ledger says why for each) and cards posted, queued or held. It ends with a testing tip: lower the quiet window to 5 minutes, or react 🧠 to judge a thread right away. New `GET /surfaces/bindings/:id/activity` (nest owner/admin) returns the counts only, read from the existing counters, windows and proposals; it never returns message text, names or Slack ids.
