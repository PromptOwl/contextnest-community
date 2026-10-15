# Licensing, plans and models

This guide is for the person installing and running a ContextNest Community server. It covers:

- which plan your server is on and what that plan includes;
- who counts as a seat;
- what happens when you reach a limit;
- how models and credits work;
- how the server keeps its license up to date.

Setting the key up for the first time is covered in [README.md → License setup](README.md#license-setup). Every endpoint mentioned here is listed in [API.md → License](API.md#license).

---

## The short version

- Every server runs on a **PromptOwl Community License key** (`pk_...`). The key decides the **plan**. A server with no key behaves like **Free**: it accepts writes while it has 10 or fewer users, and goes read-only past that until a key is installed.
- The plan sets how many **users**, **editors** and **Account Owners** the server may have. **Viewers are always free.**
- Each person is counted **once**, at their **highest role on any nest**.
- When a change would take the server past its plan, that change is refused. **Nothing you already have is ever taken away.**
- **AI models** (Hootie, workflow agents) run on **PromptOwl credits** by default. Enterprise servers may use their own model key instead.
- The server re-checks its license with PromptOwl **every minute**. A plan change made at PromptOwl reaches the server on its own, with no restart.

---

## Plans

| | **Free** | **Self-Hosted** | **Enterprise** |
|---|---|---|---|
| Price | $0, no card | Per user (talk to us) | Talk to us |
| **Users** (nest owners, admins, reviewers, Account Owners) | 10 | The number you bought (30 by default) | Unlimited |
| **Account Owners** (license owner + server admins) | 1 | Unlimited | Unlimited |
| **Editors** | None | Included | Unlimited |
| **Viewers** | Unlimited, free | Unlimited, free | Unlimited, free |
| **Model credits** per user, per month | 1,000 | 5,000 | 5,000 |
| **Your own model key** (BYOK) | No | No | Yes |
| **Sign-in** with email or Google | Yes | Yes | Yes |
| **Enterprise single sign-on** (Entra ID, Okta, any OIDC provider; licence feature `sso`) | No | No | Yes |
| **Custom assistant name and branding** (licence feature `hootie_branding`) | No | No | Yes |
| Storage | Your own servers, no limit | Same | Same |

Enterprise features (`byok`, `sso`, `hootie_branding`) are **on by default** with an Enterprise key: nothing to enable on the server or in the license console. PromptOwl can still grant one to, or remove one from, a single license. A server picks up a change on its next license check (about a minute).

A server that already signs in through an enterprise provider keeps working without `sso`; only switching providers or turning SSO back on needs Enterprise.

A **trial** key behaves like Self-Hosted until it ends.

### Getting a key and changing plan

1. Sign in at <https://app.promptowl.ai>, open **Overview → Community License**, and create a key. A new key is **Free**. It never expires and never asks for a card.
2. To move to Self-Hosted or Enterprise, use **Upgrade** on that same page, or **Manage plan** in your server's **Settings → License**. Both put you in touch with PromptOwl.
3. **The upgrade happens in place.** You keep the same key. PromptOwl changes the plan on its side, and your server picks it up within a minute. There is nothing to reinstall.

### When a trial or paid plan ends

- **Trial ends:** the key carries on as a **Free** key. The server keeps working within the Free limits.
- **Paid plan ends:** the server gets a **14-day grace period**, and Settings → License shows the date it ends. If the plan isn't renewed by then, the server becomes **read-only** (see [When the license stops being valid](#when-the-license-stops-being-valid)).
- **Small servers fall back to Free.** If the license ends, is revoked, or can't be validated, a server with **10 or fewer users** keeps writing as Free. Read-only applies past 10 users. Only a suspension by PromptOwl blocks writes at any size.

---

## Who counts as a seat

Each person is counted **once**, at the highest role they hold on **any** nest or on the server:

| Counts as | Roles |
|---|---|
| **User** | Owns a nest, nest admin, steward **reviewer** or **admin**, server admin (superadmin), license owner |
| **Editor** (subscriber) | Nest collaborator with **write**, steward **editor**, a **write** grant |
| **Viewer** (free) | Read-only access, or no role at all |

Some examples:

- Someone who reviews on three nests is **one** user.
- Someone who edits on one nest and reviews on another is **one user**, since reviewer is higher.
- A team role counts only once the team is **shared onto a nest**. Until then it reaches no nest, so it costs nothing.
- When you write a document, the server makes you its reviewer automatically. That row does **not** take a seat. A reviewer role that someone else gives you does.
- **Access keys** (headless, API-only identities) never take a seat.
- **Signing up never takes a seat.** A new account is a viewer until someone gives it a role.

To see the live counts, open **Settings → License**. The **Users** and **Editors** rows show *used of allowed*, and the info icon next to each explains what is counted.

---

## Reaching a limit

Limits are checked **when a role is raised**, never at sign-up. These actions are checked:

- making someone a nest owner (creating a nest), nest admin, steward reviewer or steward admin;
- making someone an editor (write collaborator, steward editor, write grant);
- adding someone to a team that is shared onto a nest, or sharing a team onto a nest;
- adding a server admin (superadmin). This uses both the **Account Owner** limit and the **user** limit, because a server admin is also a user.

If the change would go past the plan, it is refused and the person sees why:

- **A server admin** reads that the plan is full, with a pointer to **Settings → License** to upgrade.
- **Anyone else** reads that the plan is full and that they should ask their server admin.

Apps and scripts receive `402` with `{ "code": "plan_limit", "limit": "users" | "subscribers" | "account_owners", "max": <n> }`.

**Never refused:**

- signing up, and inviting people;
- giving anyone **viewer** access;
- **lowering** someone's role. This frees their seat right away.
- anything a server already has. A server that is over its plan (for example, after moving to a smaller plan) keeps every person and role it has. Only *new* raises are refused until the count is back under the limit.

> The check is best-effort. If two people grant the very last seat at the same moment, both may go through. Nothing breaks; the server is simply one over, and the next raise is refused.

---

## AI models and credits

Hootie (the in-nest assistant) and workflow agent runs need an AI model. The server picks the credential like this:

```
Does the license include "byok" (Enterprise)?
├── yes → does the nest have its own model key?
│         ├── yes → use the nest's key (and the nest's base URL, if it set one)
│         └── no  → has the server set its own model gateway (URL + key)?
│                   ├── yes → use it, for every model (Hootie and agent runs)
│                   └── no  → Hootie: is there an own key for the model's provider?
│                             ├── yes → use that key (kept in PromptOwl's model gateway)
│                             └── no  → use PromptOwl credits (agent runs always do)
└── no  → use PromptOwl credits (any own key is kept but ignored)
```

### PromptOwl credits (every plan)

- With the license, PromptOwl gives your server its own **model gateway key**. The server stores it **encrypted** and never shows it in any API response. If the license stops being valid, the key is dropped.
- Every call made with that key draws on your server's **monthly credit budget**: credits per user × the plan's user count. The budget resets every 30 days. If you change plan in the middle of a period, the new budget takes effect right away, and the credits you've already used still count.
- You don't need to set any key or URL yourself.

### Your own key (Enterprise only)

- Add your keys for Anthropic, OpenAI, Google Gemini, xAI Grok or Groq in **Settings → Hootie → Model keys**. PromptOwl checks each key and keeps it in its model gateway; this server only shows the last 4 characters. A single nest can also have its own Anthropic key for agent runs, in its env settings.
- Your own key is used for its provider. Calls with no own key still use PromptOwl credits.
- Or run every call through **your own model gateway** (LiteLLM in front of Bedrock, Azure, Ollama or any provider): set its URL and key in **Settings → Hootie → Model gateway** (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`). Hootie and agent runs then never use PromptOwl's gateway, so prompts and nest content stay on your network. The key is checked against your gateway when you save and stays on this server.
- A nest's key and base URL always come **as a pair**. If a nest sets only a base URL, no key is sent there.
- On other plans the Model keys and Model gateway cards are hidden, and the server refuses to save a key or gateway URL (`403`).

### Choosing the model

**Settings → Hootie → Model** lists the models available, grouped by provider and searchable; a provider you have your own key for is marked "your key". Pick by plain name, for example `claude-sonnet-5`. On PromptOwl credits, the server adds PromptOwl's internal prefix when it calls. With nothing picked, Hootie uses the gateway's default model.

---

## How the license stays up to date

### The check

- **At startup**, the server always asks PromptOwl fresh, so a restart can't hide a change.
- **Every 60 seconds** afterwards it checks again in the background. User requests never wait on PromptOwl.
- **If PromptOwl can't be reached**, the server keeps working on its last good answer, including the plan, limits and model key. It is saved in the database, so a restart doesn't lose it.

### What each check sends

Each check tells PromptOwl:

- the key;
- the number of billed users and editors;
- the number of nests;
- the server version;
- `PUBLIC_BASE_URL`, if set.

It **never** sends document content or names of people. This happens whether or not `TELEMETRY_ENABLED` is on, because it is part of licensing, not analytics. The counts are what PromptOwl's license page shows for your key.

### When the license stops being valid

| What happens | When the server reacts |
|---|---|
| PromptOwl rejects the key (ended past grace, deactivated) | After **3 rejections in a row**, about 3 minutes. One bad answer is never enough. |
| PromptOwl **suspends** the key | After **2 suspended answers within an hour**, so about 1 minute |
| PromptOwl answers "valid" again | On the next check. Nothing to reinstall. |

When the license stops being valid, a server with more than 10 users goes **read-only** (10 or fewer keep writing as Free):

- **Reading keeps working:** browsing nests, search, documents and MCP reads.
- **Writing is refused** (`503`): documents, and nest create, rename and delete.
- **Nobody is signed out**, and the installed key stays in place. When the license is valid again, writing comes back on the next check.
- **Who is told what:**
  - The license owner and server admins see the reason (ended, suspended, the grace date) and who to contact.
  - Everyone else sees one neutral line: *"This workspace is read-only right now. Your administrator has been notified."*

---

## Where to look

| You want to… | Go to |
|---|---|
| See the plan, the counts and the limits | **Settings → License** |
| Upgrade or change plan | **Settings → License → Manage plan**, or app.promptowl.ai → Community License |
| Pick the Hootie model | **Settings → Hootie** |
| Set your own model key (Enterprise) | **Settings → Hootie → Model keys**, or a nest's env settings |
| Turn on Google sign-in (every plan) or Entra / Okta SSO (Enterprise) | **Settings → Features → Single sign-on**, then the **Single sign-on** tab |
| Read the same data from a script | `GET /admin/license` (server admin), `GET /license/status` (public, no counts) |

## Questions

**We hit the user limit. Can existing people still work?** Yes. Only new role raises are refused. Everyone keeps their current role, and viewers can still be added.

**We moved to a smaller plan and are now over it. What happens?** Nothing is removed. New raises are refused until enough roles are lowered to bring the count under the limit.

**PromptOwl is down. Does our server stop?** No. It keeps running on the last answer it saved, models included. It catches up when PromptOwl is back.

**Does turning off telemetry stop the license check?** No. The license check is separate from analytics, and it sends only the counts listed above.

**We're on Free. Why can't I add a second server admin?** Free includes one Account Owner, and the license owner already fills it. Upgrade to add more.
