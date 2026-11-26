---
"@promptowl/contextnest-community": minor
---

Slack now connects through one Slack app per server. Its manifest, addresses and three keys are managed from Control room → Setup or Server settings → Surfaces, and both show the same values. The "Hosted Slack app" switch is gone: Slack is on whenever Surfaces is, and installs already connected from their own manifest keep working until disconnected.

Saving a Client ID or Client secret checks it with Slack and shows which one is wrong under that field instead of storing it. When Slack refuses the keys at approval, the error page says which keys and where to fix them. Disconnecting Slack clears half-finished connects, Setup always lets you pick the nest before connecting, and the Email domains box follows the nest you pick.
