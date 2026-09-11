---
"@promptowl/contextnest-community": patch
---

Give the agent setup prompt failure branches, so a first read that fails is recoverable instead of terminal.

Copy the "Set up an agent" prompt into a coding agent and, if anything goes wrong, it used to have one instruction: stop. That is the wrong answer on an unlicensed server, where the documented first call is blocked but the nest is still perfectly readable — and it is the wrong answer in a sandbox whose network policy blocks the host, where retrying can never help.

The prompt now branches on what actually came back. **503** means the server has no licence, so it points at `GET /export?format=markdown`, which is not gated and returns every document with its text in one call. **401** means the key is wrong or was never expanded from the environment. **403** distinguishes the server refusing you — usually a key scoped to another nest, which you can fix — from a gateway refusing on your behalf, which you cannot. **No response at all** means the environment cannot reach the host, so the answer is a connector your client dials server-side rather than another attempt.

Three smaller corrections come with it. The key is now located (`CONTEXTNEST_API_KEY`) rather than merely requested, since the old copy asked the agent to ask for it while forbidding it in chat and naming no other channel. Write capability is stated only where it is true — on an unlicensed server writes are blocked along with everything else non-GET, and claiming otherwise made agents distrust the rest of the brief. And the prompt no longer tells agents to assume a `nodes/` id prefix, which exists on nests created in the app and not on imported ones; it says to reuse the id exactly as the server returned it.
