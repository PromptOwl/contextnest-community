/**
 * po-1407: a Surfaces judge failure says why.
 *
 *  - classifyJudgeFailure maps any throw out of the judge to one fixed reason
 *    code (model / Slack / nest / output / database / unknown) and a redacted
 *    log detail: the error's class name and HTTP status, never its message.
 *  - createTurn: current Claude models answer a non-default `temperature` with
 *    a 400. The judge (and the team-chat watcher) ask for temperature 0, so a
 *    model that refuses it is retried once without it, and remembered.
 *  - The Control room has words for every code the judge can write.
 *
 * The end-to-end path (window → ledger → MCP) is in surfaces-s2a-judge-r1.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { classifyJudgeFailure, JUDGE_FAILURE_CODES, JudgeRunError, judgeFailureLogLine, ruleText } from "../src/surfaces/services/judge-failure.js";
import { SlackApiError } from "../src/surfaces/adapters/slack/api.js";
import { SurfaceRateLimited } from "../src/surfaces/contract.js";
import { reasonLabel, whatCell, type LedgerEntry } from "../ui/src/lib/control-room-overview.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** What the Anthropic SDK throws: an Error subclass carrying the HTTP status. */
function apiError(status: number, message = "secret-ish provider text sk-ant-XXXX") {
  class APIError extends Error {
    constructor(public readonly status: number) {
      super(message);
    }
  }
  return new APIError(status);
}
const named = (name: string, message = "chat text: we agreed to fire Bob") => Object.assign(new Error(message), { name });

describe("classifyJudgeFailure", () => {
  it("model failures: auth refused, rate-limited, timed out, request refused, anything else", () => {
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(401)), "model").code).toBe("model_auth");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(403)), "model").code).toBe("model_auth");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(429)), "model").code).toBe("model_rate_limited");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(400)), "model").code).toBe("model_rejected");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(404)), "model").code).toBe("model_rejected");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(500)), "model").code).toBe("model_error");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(529)), "model").code).toBe("model_error");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, named("APIConnectionError")), "model").code).toBe("model_error");
    for (const n of ["AbortError", "TimeoutError", "APIConnectionTimeoutError", "APIUserAbortError"]) {
      expect(classifyJudgeFailure(new JudgeRunError(ZERO, named(n)), "model").code, n).toBe("model_timeout");
    }
  });

  it("an out-of-credit model account is model_billing, direct from Anthropic or through LiteLLM; other 400s stay model_rejected", () => {
    const anthropicMsg = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    // The Anthropic SDK: status 400, the API's message in error.error.message and in .message.
    const direct = Object.assign(new Error(`400 ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: anthropicMsg } })}`), {
      status: 400,
      error: { type: "error", error: { type: "invalid_request_error", message: anthropicMsg } },
    });
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, direct), "model").code).toBe("model_billing");
    // LiteLLM proxy (production, 2026-11-18): its BadRequestError wraps Anthropic's body in its own message.
    const viaLiteLlm = Object.assign(
      new Error(
        `400 {"error":{"message":"litellm.BadRequestError: AnthropicException - {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"${anthropicMsg}\"}}","type":null,"param":null,"code":"400"}}`,
      ),
      { status: 400, error: { error: { message: `litellm.BadRequestError: AnthropicException - ${anthropicMsg}`, code: "400" } } },
    );
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, viaLiteLlm), "model").code).toBe("model_billing");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(402, "Payment Required")), "model").code).toBe("model_billing");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(429, "You exceeded your current quota, please check your plan and billing details")), "model").code).toBe("model_billing");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(400, "messages: roles must alternate")), "model").code).toBe("model_rejected");
    // The log line still carries no message text.
    const line = judgeFailureLogLine("w3", classifyJudgeFailure(new JudgeRunError(ZERO, viaLiteLlm), "model"));
    expect(line).toMatch(/reason=model_billing status=400$/);
    expect(line).not.toMatch(/credit|Anthropic|litellm/i);
  });

  it("a model the key can't use, or that doesn't exist, is model_unavailable; a refused key stays model_auth", () => {
    for (const [status, message] of [
      [401, "key not allowed to access model. This key can only access models=['default-openai/gpt-5']. Tried to access cgdfgdg"],
      [403, "team_model_access_denied"],
      [400, "Invalid model name passed in model=cgdfgdg"],
      [404, "The model `cgdfgdg` does not exist or you do not have access to it."],
    ] as const)
      expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(status, message)), "model").code, message).toBe("model_unavailable");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(401, "invalid x-api-key")), "model").code).toBe("model_auth");
    expect(classifyJudgeFailure(new JudgeRunError(ZERO, apiError(400, "messages: roles must alternate")), "model").code).toBe("model_rejected");
  });

  it("every rule of a decision reads as words", () => {
    for (const r of ["items: proposed has none", "title", "target_folder", "summary", "evidence_message_ids"]) expect(ruleText(r)).not.toMatch(/≥|_|^part of it/);
    expect(ruleText("brand new rule")).toMatch(/brand new rule/);
  });

  it("the status is carried for the log; the message never is", () => {
    const f = classifyJudgeFailure(new JudgeRunError(ZERO, apiError(401)), "model");
    expect(f).toEqual({ code: "model_auth", name: "APIError", status: 401 });
    const line = judgeFailureLogLine("w1", f);
    expect(line).toBe("[surfaces] judging window w1 failed: APIError reason=model_auth status=401");
    expect(line).not.toMatch(/sk-ant|secret/);
    const noStatus = judgeFailureLogLine("w2", classifyJudgeFailure(named("SyntaxError"), "verdict"));
    expect(noStatus).toBe("[surfaces] judging window w2 failed: SyntaxError reason=invalid_output");
    expect(noStatus).not.toMatch(/Bob/);
  });

  it("Slack: an API error or a rate limit from Slack, wherever it happens", () => {
    expect(classifyJudgeFailure(new SlackApiError("missing_scope"), "commit").code).toBe("slack_fetch_failed");
    expect(classifyJudgeFailure(new SurfaceRateLimited(30), "setup").code).toBe("slack_fetch_failed");
    expect(classifyJudgeFailure(new Error("x"), "slack").code).toBe("slack_fetch_failed");
  });

  it("nest read, schema/parse, database and unknown", () => {
    expect(classifyJudgeFailure(new Error("ENOENT"), "nest").code).toBe("nest_read_failed");
    expect(classifyJudgeFailure(new TypeError("x is undefined"), "verdict").code).toBe("invalid_output");
    expect(classifyJudgeFailure(named("ZodError"), "setup").code).toBe("invalid_output");
    expect(classifyJudgeFailure(named("SqliteError"), "commit").code).toBe("db_error");
    // Settling spend after a failed model call happens in the model stage: a DB error there is still a DB error.
    expect(classifyJudgeFailure(named("SqliteError"), "model").code).toBe("db_error");
    expect(classifyJudgeFailure(Object.assign(new Error("deadlock"), { code: "40P01", severity: "ERROR" }), "commit").code).toBe("db_error");
    expect(classifyJudgeFailure(new Error("boom"), "setup").code).toBe("unknown_error");
    expect(classifyJudgeFailure("a string", "setup")).toEqual({ code: "unknown_error", name: "error", status: null });
  });

  it("every code is snake_case and fits runs.reason_code (≤ 40 chars)", () => {
    for (const c of JUDGE_FAILURE_CODES) expect(c).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });
});

describe("Control room words for judge failures", () => {
  const failed = (code: string | null): LedgerEntry => ({
    entry_id: "win_1",
    at: "2026-11-18T14:11:21.000Z",
    nest: { id: "n1", label: "Operations Nest" },
    agent: { node_id: "nodes/nest-listener-c35ebd69", name: "Listener", source: "surfaces" },
    run: { id: "run_1", outcome: "failed", cost_usd: 0 },
    verdict: { code: "error", reason_code: code, kinds: [], message_count: 4 },
    decision: null,
    proposal: null,
    review: null,
    commit: null,
    source: { kind: "slack", label: "#engineering", url: null },
    redacted: null,
  });

  it("every judge failure code has its own readable label (never the de-snake-cased fallback, never 'No reason given')", () => {
    for (const code of JUDGE_FAILURE_CODES) {
      const label = reasonLabel(code);
      const fallback = code.replace(/_/g, " ");
      expect(label, code).not.toBe(fallback[0].toUpperCase() + fallback.slice(1));
      expect(label, code).not.toBe("No reason given");
      expect(whatCell(failed(code))).toEqual({ title: "Run failed", sub: label, redacted: false });
    }
    expect(reasonLabel("model_auth")).toBe("The model key was refused");
    expect(reasonLabel("model_rejected")).toBe("The model refused the request");
    expect(reasonLabel("model_billing")).toBe("The model account is out of credit");
  });

  it("'No reason given' stays only for a row with no code", () => {
    expect(whatCell(failed(null)).sub).toBe("No reason given");
  });
});

// ─── createTurn and models that refuse `temperature` ─────────────────────────
interface Call {
  params: Record<string, unknown>;
}
let calls: Call[] = [];
/** Models the fake API answers with a 400 when `temperature` is sent. */
let rejectsTemperature = new Set<string>();
let failWith: { status: number; message: string } | null = null;

function sdkError(status: number, message: string) {
  return Object.assign(new Error(message), { status, error: { error: { type: "invalid_request_error", message } } });
}
class FakeAnthropic {
  messages = {
    create: async (params: Record<string, unknown>) => {
      calls.push({ params });
      if (failWith) throw sdkError(failWith.status, failWith.message);
      if ("temperature" in params && rejectsTemperature.has(String(params.model))) {
        throw sdkError(400, "temperature: sampling parameters are not supported for this model");
      }
      return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}
async function loadModel() {
  vi.resetModules();
  vi.doMock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
  return await import("../src/metacognition/model.js");
}
const credential = { apiKey: "k", baseUrl: null, source: "own" as const, defaultModel: null };
const request = (model: string) => ({ model, system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], max_tokens: 256, temperature: 0 });

describe("createTurn with a temperature (the judge's call)", () => {
  beforeEach(() => {
    calls = [];
    rejectsTemperature = new Set();
    failWith = null;
  });

  it("a model that 400s on temperature is retried once without it, and remembered for the next turn", async () => {
    rejectsTemperature.add("claude-sonnet-5");
    const { createTurn } = await loadModel();
    const r = await createTurn({ credential, request: request("claude-sonnet-5") });
    expect(r.stop_reason).toBe("end_turn");
    expect(calls).toHaveLength(2);
    expect(calls[0].params.temperature).toBe(0);
    expect(calls[1].params).not.toHaveProperty("temperature");
    calls = [];
    await createTurn({ credential, request: request("claude-sonnet-5") });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).not.toHaveProperty("temperature");
  });

  it("a model that takes temperature keeps it (one call)", async () => {
    const { createTurn } = await loadModel();
    await createTurn({ credential, request: request("claude-haiku-4-5") });
    expect(calls).toHaveLength(1);
    expect(calls[0].params.temperature).toBe(0);
  });

  it("any other 400 is a real error: no retry, nothing remembered", async () => {
    failWith = { status: 400, message: "messages: roles must alternate" };
    const { createTurn } = await loadModel();
    await expect(createTurn({ credential, request: request("claude-sonnet-5") })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
    failWith = null;
    calls = [];
    await createTurn({ credential, request: request("claude-sonnet-5") });
    expect(calls[0].params.temperature).toBe(0);
  });
});
