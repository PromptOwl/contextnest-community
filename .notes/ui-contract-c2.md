# UI contract — team chat C2 (conversations and live), for C3

Server slice: PO-1197 (PR #556). This file says which screen calls what. Request and response shapes live in API.md, section "Team chat — conversations, private channels, preferences, presence, live events"; this file does not repeat them.

## Gate: when chat exists at all

- Show chat for a nest only when `GET /nests/:id` returns `chat: true`. It is true when the server switch is on, the nest's own setting is on, and the caller is a member of the nest.
- `chat: false` means no chat UI for that nest: no sidebar section, no launcher, no unread badge. Every chat route answers `404` then, so treat a `404` from a chat route as "chat is gone here" and drop back to the nest view.
- The superadmin switch is `team_chat_enabled` in `GET/PATCH /admin/settings`; `/health` reports `team_chat`.
- The nest switch is `GET/PATCH /nests/:id/chat/settings` `{ chat }`. Only the nest's owner or an admin may PATCH (`403` otherwise). This route stays reachable while the nest's chat is off, so the toggle can turn it back on.

## Screens and the calls behind them

### Sidebar (per nest)
- Channels: `GET /nests/:id/channels`. Each row carries `private` and `member`; show a lock on `private`. A private channel the caller is not in never appears.
- Direct messages: `GET /nests/:id/conversations`. Each row carries `kind` (`dm` | `group`), `title` (the other members' names, for the caller), `members`, `unread`, `last_activity_at`. Sort by `last_activity_at`.
- Unread numbers come from the same rows; refresh them on live events (below).

### App-wide badge
- `GET /me/chat/unread` returns `{ total, mentions, nests[] }` across every nest. Use it for the launcher badge on every page. The server caches it for about 5 seconds, so do not poll faster than that.

### New message (start a DM or group)
- `POST /nests/:id/conversations { members }`. Members are people added to the nest (email or name) and agents (`@handle`). The caller is always added.
- `201` = new conversation; `200` = the same member set already has one: open it. `400` = fewer than 2 or more than 50 members, or someone not added to the nest; show the error text.
- For the people picker, use the nest's people and `GET /nests/:id/agent-handles`.

### Conversation view
- Read: `GET /nests/:id/conversations/:cid` with `?limit=`/`?offset=`, `?thread=<id>`, or `?since=<cursor>`. The shapes are the channel timeline, thread and since shapes, with `conversation` in place of `channel`.
- Post and reply: the existing thread routes on the conversation id, `POST /nests/:id/nodes/<encoded cid>/annotations` and `…/annotations/:threadId/comments`. Use the same composer as channels.
- Mark read: `POST /nests/:id/conversations/:cid/read` when the view is open and focused.
- Group only: leave with `POST …/:cid/leave`, add someone with `POST …/:cid/members { member }`. On a DM both answer `409`; hide both actions when `kind` is `dm`.
- Promote a thread: the existing promote flow. A read-only member gets `403`; hide the action for them.

### Private channels
- Create: the existing new-channel form plus a "private" checkbox: `POST /nests/:id/channels { name, purpose?, private: true }`. Writers only.
- Members panel: `GET /nests/:id/channels/:name/members`.
- Invite: `POST …/channels/:name/members { member }` (a writer, or a member of the channel).
- Join a public channel: `POST …/channels/:name/join`. Leave: `POST …/channels/:name/leave`. The last member of a private channel cannot leave (`409`); show the message.
- Make private or public: `POST …/channels/:name/private { private }`. Only the nest's owner or an admin; hide the control for anyone else.

### Notification preferences
- `GET /me/chat/preferences` and `PUT /me/chat/preferences { nest_id, conversation?, level }`, where level is `all`, `mentions` (the default) or `none`.
- Without `conversation`, the PUT sets the nest default. With it, the PUT sets one channel or conversation.
- Show a muted icon on `none`. Muting stops inbox and email notifications only: unread counts and My Work mentions still show.

### Presence and typing
- Heartbeat: `POST /nests/:id/chat/presence { status? }` about every 2 minutes while the app is visible. An entry expires 5 minutes after the last heartbeat. Status is at most 80 characters. More than 30 heartbeats in a minute answers `429`.
- Who is around: `GET /nests/:id/chat/presence`. `last_seen` is rounded down to the minute.
- Typing: `POST /nests/:id/chat/typing { conversation }`, sent at most once every few seconds while the composer has text. Others get it as a `typing` event. Nothing is stored, so show it for about 5 seconds after the last event.

## Live updates

- Open one `EventSource` per open nest: `GET /nests/:id/chat/events`. Reconnect with `Last-Event-ID`. On a `reset` event, re-read with `?since=`.
- Events carry pointers, never message text. On `message.new` or `message.changed`, re-read the container with `?since=` (or `?thread=` when that thread is open).
- `read.marked` is the caller's own mark from another tab: clear that unread count.
- `typing` and `presence` update their indicators. `channel.created`, `channel.archived`, `conversation.created` and `membership.changed` refresh the sidebar lists. On `membership.changed` with `action: "left"` for the caller, close the view.
- A person may hold 5 streams at once; the sixth answers `429`. One stream per nest per tab is enough.
- If the stream fails, fall back to polling `?since=` and `GET /me/chat/unread`.

## Errors to design for

- `404` on a conversation or private channel means "does not exist for you". It is the same answer for an unknown id, so never say "you were removed"; just leave the view.
- `403` means the caller may read but not do this (a read-only collaborator, a read-only API key, not the owner or an admin).
- `409` is a refused state change (leave a DM, the last member leaves a private channel). Show the server's `error` text as-is.

## Known limits (do not build UI for these yet)

- C1 message actions (reactions, edit, delete, pins, saved, message search, permalinks) work in channels only. In a DM or group conversation they answer `404`. Follow-up ticket: PO-1402, "[Community Nest] Team chat: C1 message actions work in conversations". Hide those actions in conversation views until it ships.
- `@channel` / `@here` in a conversation or private channel reaches its members only.
- No "request to join" a private channel, no archive or delete of a conversation (leave only), no unread per thread.
- Presence and the event stream are per server process. On a multi-instance deploy, the polling fallback covers the gap.
