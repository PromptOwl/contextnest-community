---
type: document
title: Launching the community nest locally (+ Docker/UI build gotchas)
tags: [community, docker, gotcha, setup, runbook]
---

# Launching the community nest locally

The community server listens on **port 3838** (`COMMUNITY_PORT`). UI + API are
both served by `dist/index.js`; the dashboard SPA is served via a catch-all
`app.get("*")` from `dist/web3/index.html` (`src/app.ts:484`).

## Fast local launch (when Docker is broken)

```
cd community
npm run build:ui                  # only if dist/web3/index.html is missing
PORT=3838 DATA_ROOT="$(pwd)/data" node dist/index.js &
xdg-open http://localhost:3838/
```

`/health` returns 200 even when the UI is missing — root `/` is the real check.

## Gotcha 1 — `make up` / Docker build fails

`community/Dockerfile` runs `RUN corepack enable && npm ci` **before**
`COPY . .`. `npm ci` ends up invoking `npm run build` (`tsup src/index.ts`),
but `src/` isn't in the image yet → `Cannot find src/index.ts` → build aborts.
The canonical `make up` path is broken until the Dockerfile copies source
before building (or stops running build during install).

## Gotcha 2 — UI bundle shipped without index.html

`dist/web3/` can exist with only an empty `assets/` dir and **no `index.html`**
(the `build:ui` step never completed). When that happens the server boots fine,
`/health` is 200, the API works, but `/` returns **404** because the static
catch-all can't find `index.html`. Fix: `npm run build:ui` (vite, ~7s) which
writes `dist/web3/index.html` + assets. Only then does `/` serve 200.

Both surfaced 2026-06-26 while dogfood-launching the community nest in a browser.
