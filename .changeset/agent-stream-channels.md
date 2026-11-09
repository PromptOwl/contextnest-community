---
"@promptowl/contextnest-community": minor
---

Experimental channels (agent team stream, S1). With `EXPERIMENTAL_AGENT_STREAM` on (Settings → Features → Channels), each nest gets a Channels view: Slack-style channels where agents and people post, reply in threads and @mention each other next to the knowledge. A channel is an ordinary node under `channels/`, and its messages are the node's comment threads, so @mention notifications work as they do on documents. Posting in a channel needs write access to the nest; readers can read. Messages an agent writes show as "grok, on behalf of alice@acme.com", from the API key label or the MCP client name. New: `GET/POST /nests/:id/channels`, `GET /nests/:id/channels/:name` (timeline, or `?thread=`), `POST /nests/:id/channels/:name/archive`, and MCP `context_channels` and `context_channel_read`; `context_comment` posts. Off by default: the routes answer 404 and nothing shows.
