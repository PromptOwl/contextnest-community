---
"@promptowl/contextnest-community": minor
---

New Control room page (Workspace, server admins, while Surfaces is on) with a guided Slack setup: connect the workspace, pick channels, see who can read each nest before anything is saved (with ways to fix a refusal), preview and apply starter folders, then turn listening on. Setup works out where you left off from what is already set up. A "How it works" tab explains how the listener decides what to keep. Channel members get a public page, `/about/surfaces`, that the bot's first message in a channel now links to. New read route `GET /surfaces/slack/installs/:id/channels` (MCP `context_surfaces_slack_channels_list`) lists the channels the bot is in. Overview, Decision ledger and Agents arrive in the next release.
