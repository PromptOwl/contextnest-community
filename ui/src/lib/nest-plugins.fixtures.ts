/**
 * Mocked GET /nests/:id/plugins responses for the Plugins page tests, shaped
 * exactly like the server's describe() (src/plugins/service.ts). github-markdown
 * mirrors the real manifest in CommunityNestSDK packages/plugin-github-markdown;
 * memo is test/fixtures/plugins/memo.mjs, configured and with one run.
 */
import type { NestPlugin, NestPluginsResponse } from "./api";

export const githubMarkdown: NestPlugin = {
  name: "github-markdown",
  version: "0.1.0",
  displayName: "GitHub Markdown",
  description:
    "Mirror the markdown files of a GitHub repository into this nest, preserving directory structure. Re-runs only fetch changed files.",
  capabilities: ["pull", "process"],
  itemKinds: ["document"],
  settingsSchema: {
    type: "object",
    required: ["repo"],
    properties: {
      repo: { type: "string", title: "Repository", description: "owner/name", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
      token: {
        type: "string",
        title: "Personal access token",
        description: "Needed for private repos and to lift the anonymous rate limit.",
        "x-secret": true,
      },
      branch: { type: "string", title: "Branch", description: "Defaults to the repository's default branch." },
      mode: { type: "string", title: "Mode", enum: ["all-markdown", "single-file"], default: "all-markdown" },
      path: { type: "string", title: "Path", description: "all-markdown: subdirectory to restrict to. single-file: the file (default README.md)." },
      folder: { type: "string", title: "Target folder", description: "Folder inside the nest to mirror under. Empty = nest root." },
      maxFiles: { type: "integer", title: "Max files", default: 500, minimum: 1 },
    },
  },
  secretKeys: ["token"],
  faces: { pull: true, process: true, healthcheck: true },
  configured: false,
  enabled: false,
  mode: "raw",
  folder: null,
  settings: {},
  cursor: null,
  system: null,
  last_run_at: null,
  last_status: null,
  runs: [],
};

export const memoConfigured: NestPlugin = {
  name: "memo",
  version: "0.0.1",
  displayName: "Memo",
  description: "test plugin",
  capabilities: ["pull"],
  itemKinds: ["document"],
  settingsSchema: {
    type: "object",
    required: ["prefix"],
    properties: {
      prefix: { type: "string", title: "Prefix" },
      token: { type: "string", title: "Token", "x-secret": true },
    },
  },
  secretKeys: ["token"],
  faces: { pull: true, process: false, healthcheck: true },
  configured: true,
  enabled: true,
  mode: "raw",
  folder: null,
  // The server masks a stored secret: presence only, never the value.
  settings: { prefix: "Memo", token: "••••" },
  cursor: { n: 1 },
  system: { id: "u-sys-1", name: "Plugin: Memo", email: "plugin-memo@system.local", capability: "write" },
  last_run_at: "2026-10-23T18:00:05.000Z",
  last_status: "clean",
  runs: [
    {
      id: "run-1",
      triggered_by: "manual:owner@acme.dev",
      status: "clean",
      created: 3,
      updated: 1,
      unchanged: 12,
      conflicts: [],
      failed: [],
      error: null,
      started_at: "2026-10-23T18:00:00.000Z",
      finished_at: "2026-10-23T18:00:05.000Z",
    },
  ],
};

/** The github plugin enabled and with a failed + a conflicted run. */
export const githubEnabled: NestPlugin = {
  ...githubMarkdown,
  configured: true,
  enabled: true,
  folder: "engineering",
  settings: { repo: "PromptOwl/context-nest-spec", branch: "main" },
  system: { id: "u-sys-2", name: "Plugin: GitHub Markdown", email: "plugin-gh@system.local", capability: "write" },
  last_run_at: "2026-10-23T19:00:02.000Z",
  last_status: "failed",
  runs: [
    {
      id: "run-3",
      triggered_by: "manual:editor@acme.dev",
      status: "failed",
      created: 0,
      updated: 0,
      unchanged: 0,
      conflicts: [],
      failed: [{ externalId: "docs/a.md", error: "not an allowed folder" }],
      error: "GitHub returned HTTP 404 listing the main branch tree of PromptOwl/context-nest-spec",
      started_at: "2026-10-23T19:00:00.000Z",
      finished_at: "2026-10-23T19:00:02.000Z",
    },
    {
      id: "run-2",
      triggered_by: "manual:owner@acme.dev",
      status: "conflicts",
      created: 4,
      updated: 0,
      unchanged: 9,
      conflicts: [{ externalId: "README.md", id: "nodes/engineering/readme" }],
      failed: [],
      error: null,
      started_at: "2026-10-23T17:00:00.000Z",
      finished_at: "2026-10-23T17:00:04.000Z",
    },
  ],
};

export const pluginsResponse: NestPluginsResponse = {
  plugins: [{ ...githubMarkdown, runs: memoConfigured.runs }, memoConfigured],
  load_errors: [],
};
