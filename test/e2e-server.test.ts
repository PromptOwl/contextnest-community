import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { DIRECTORY_PEOPLE, FEATURE_ENV, FREE_SEAT_PEOPLE, PAID_SEAT_PEOPLE, SEATS_NEST_NAME, licenseAnswer, readSettings, serverEnv } from "../tests/e2e-server/lib.mjs";
import { entitlementOf } from "../src/auth/license.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ACCOUNTS = {
  TEST_ACCOUNT1_USER: "admin@example.com",
  TEST_ACCOUNT1_PW: "Admin-pass-1!",
  TEST_ACCOUNT2_USER: "member@example.com",
  TEST_ACCOUNT2_PW: "Member-pass-1!",
};

describe("e2e server launcher (Playwright against this checkout's own build)", () => {
  describe("settings", () => {
    it("reads the same account variables Playwright does; the first is the admin", () => {
      const s = readSettings(ACCOUNTS);
      expect(s.accounts.map((a) => a.email)).toEqual(["admin@example.com", "member@example.com"]);
      expect(s.baseUrl).toBe("http://127.0.0.1:3838");
      expect(s.licenseUrl).toBe("http://127.0.0.1:4010");
      expect(s.serverCommand).toEqual(["node", "dist/index.js"]);
    });

    it("works with one account", () => {
      const s = readSettings({ TEST_ACCOUNT1_USER: "a@example.com", TEST_ACCOUNT1_PW: "Admin-pass-1!" });
      expect(s.accounts).toHaveLength(1);
    });

    it("refuses to start without the admin account, or with half an account", () => {
      expect(() => readSettings({})).toThrow(/TEST_ACCOUNT1_USER and TEST_ACCOUNT1_PW are required/);
      expect(() => readSettings({ ...ACCOUNTS, TEST_ACCOUNT2_PW: undefined })).toThrow(/both _USER and _PW/);
    });

    it("takes its ports and the server command from the environment", () => {
      const s = readSettings({
        ...ACCOUNTS,
        E2E_SERVER_PORT: "4000",
        E2E_LICENSE_PORT: "4001",
        E2E_SERVER_CMD: "node --import tsx src/index.ts",
      });
      expect(s.baseUrl).toBe("http://127.0.0.1:4000");
      expect(s.licenseUrl).toBe("http://127.0.0.1:4001");
      expect(s.serverCommand).toEqual(["node", "--import", "tsx", "src/index.ts"]);
    });
  });

  describe("the server's environment", () => {
    const env = serverEnv(readSettings(ACCOUNTS), "/tmp/data");

    it("is a fresh SQLite server in key mode that anyone may sign up on", () => {
      expect(env).toMatchObject({
        PORT: "3838",
        DATA_ROOT: "/tmp/data",
        DB_DRIVER: "sqlite",
        AUTH_MODE: "key",
        MANUAL_SIGN_IN: "open",
        NEST_CREATION: "everyone",
      });
    });

    it("never reaches PromptOwl: the license check goes to the launcher and telemetry is off", () => {
      expect(env.PROMPTOWL_API_URL).toBe("http://127.0.0.1:4010");
      expect(env.TELEMETRY_ENABLED).toBe("false");
      expect(env.SMTP_URL).toBe("smtp://127.0.0.1:4025"); // the launcher's discard-all sink
    });

    it("turns on every feature switch the server reads from the environment", () => {
      // A new FEATURE_* / EXPERIMENTAL_* boolean in config.ts must be switched
      // on here too, or its suite would skip (or fail) on the PR build.
      const config = readFileSync(join(repoRoot, "src/config.ts"), "utf8");
      const switches = [...config.matchAll(/process\.env\.((?:FEATURE|EXPERIMENTAL)_[A-Z_]+) === "true"/g)].map((m) => m[1]);
      expect(switches.length).toBeGreaterThan(3);
      // Left off on purpose: needs Slack app credentials / a security review.
      const leftOff = ["FEATURE_SURFACES_SLACK_HOSTED", "FEATURE_SUBAGENT_RUNS"];
      for (const name of new Set(switches)) {
        if (leftOff.includes(name)) expect(FEATURE_ENV).not.toHaveProperty(name);
        else expect(FEATURE_ENV, name).toHaveProperty(name, "true");
      }
    });
  });

  describe("the license answer", () => {
    const answer = licenseAnswer("admin@example.com");

    it("is a valid enterprise license owned by the admin account", () => {
      expect(answer).toMatchObject({ valid: true, tier: "enterprise", suspended: false, owner_email: "admin@example.com" });
    });

    it("reads as an unlimited enterprise plan in the server's own entitlement code", () => {
      const ent = entitlementOf({
        valid: true,
        tier: answer.tier,
        org: answer.org,
        limits: answer.limits as any,
        suspended: false,
        suspendedReason: null,
        ownerEmail: answer.owner_email,
      });
      expect(ent).toEqual({ plan: "enterprise", maxUsers: null, maxAccountOwners: null, maxSubscribers: null });
    });
  });

  it("seeds directory people the collaborator and steward suites can find", () => {
    // tests/src/lib/collaborators_api.js and stewards_api.js look for these.
    for (const email of DIRECTORY_PEOPLE) expect(email).toMatch(/^qa-[a-z0-9._-]+@example\.com$/i);
    // stewards_api.freeTestPerson tries qa-viewer first and needs it unpaid.
    expect(FREE_SEAT_PEOPLE).toEqual(["qa-viewer@example.com"]);
    expect(PAID_SEAT_PEOPLE.length).toBeGreaterThan(0);
    expect(SEATS_NEST_NAME).not.toMatch(/^AUTO_/); // the orphan sweep must keep it
  });

  describe("the workflow", () => {
    const wf = yaml.load(readFileSync(join(repoRoot, ".github/workflows/e2e-pr-build.yml"), "utf8")) as any;
    const job = wf.jobs["e2e-pr-build"];
    const steps: Array<{ name: string; run?: string }> = job.steps;
    const names = steps.map((s) => s.name);

    it("builds the PR before it starts the server, and starts it before Playwright", () => {
      const at = (n: string) => names.indexOf(n);
      expect(at("Build the server and the UI")).toBeGreaterThan(-1);
      expect(at("Start the PR's build on localhost")).toBeGreaterThan(at("Build the server and the UI"));
      expect(at("Run Playwright tests")).toBeGreaterThan(at("Start the PR's build on localhost"));
    });

    it("points Playwright at localhost with the accounts the launcher seeds", () => {
      expect(job.env.BASE_URL).toBe("http://localhost:3838");
      const s = readSettings(job.env);
      expect(s.accounts).toHaveLength(2);
      expect(job.env.TEST_ACCOUNT1_ALIAS).toBe("primary_user");
      expect(job.env.TEST_ACCOUNT2_ALIAS).toBe("secondary_user");
    });

    it("uses no secrets and no turnstile, so PRs (and forks) run at once", () => {
      const text = readFileSync(join(repoRoot, ".github/workflows/e2e-pr-build.yml"), "utf8");
      expect(text).not.toMatch(/\$\{\{\s*secrets\./);
      expect(text).not.toContain("e2e-turnstile");
      expect(wf.concurrency.group).toContain("github.event.pull_request.number");
    });

    it("turns every 'not deployed here' skip into a failure", () => {
      for (const name of ["CN_EXPECT_ACCESS_REQUESTS", "CN_EXPECT_BRIDGE", "CN_EXPECT_CONTROL_ROOM", "CN_EXPECT_STREAM_FEED", "CN_EXPECT_NEST_HOME"]) {
        expect(job.env[name], name).toBe("1");
      }
      // Any CN_EXPECT_* a spec reads must be set in the job.
      const used = new Set<string>();
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".js")) {
            for (const m of readFileSync(full, "utf8").matchAll(/process\.env\.(CN_EXPECT_[A-Z_]+)/g)) used.add(m[1]);
          }
        }
      };
      walk(join(repoRoot, "tests/features"));
      walk(join(repoRoot, "tests/src"));
      for (const name of used) expect(job.env[name], name).toBe("1");
    });
  });
});
