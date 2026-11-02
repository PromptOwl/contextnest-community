/**
 * Hootie's model call against models that don't take every parameter.
 *
 * The model name is an admin setting: it can be a current Claude (adaptive
 * thinking + effort), an older one like Haiku 4.5 that rejects both, or a
 * gateway model that knows neither. The SDK is replaced with a fake that
 * behaves like each, so these tests exercise the real streamAnswer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface Call {
  model: string;
  params: Record<string, unknown>;
}
let calls: Call[] = [];
/** Which models the fake API rejects tuned requests for, and how. */
let rejectsTuned = new Set<string>();
/** When set, every request fails with this (billing, bad input …). */
let alwaysFail: { status: number; message: string } | null = null;
/** Models whose gateway refuses any request carrying tools (400). */
let rejectsTools = new Set<string>();
/** When true, a request with tools ends in a search_nest call. */
let replyWithToolUse = false;

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), {
    status,
    error: { error: { type: "invalid_request_error", message } },
  });
}

class FakeAnthropic {
  messages = {
    stream: (params: Record<string, unknown>) => {
      calls.push({ model: String(params.model), params });
      const tuned = "thinking" in params || "output_config" in params;
      const withTools = Array.isArray(params.tools) && params.tools.length > 0;
      const fail = alwaysFail
        ? apiError(alwaysFail.status, alwaysFail.message)
        : tuned && rejectsTuned.has(String(params.model))
          ? apiError(400, "thinking: adaptive thinking is not supported on this model")
          : withTools && rejectsTools.has(String(params.model))
            ? apiError(400, "tools: Extra inputs are not permitted")
            : null;
      const toolUse = withTools && replyWithToolUse;
      return {
        async *[Symbol.asyncIterator]() {
          // A rejected request fails before any event, as the real API does.
          if (fail) throw fail;
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
        },
        finalMessage: async () =>
          toolUse
            ? {
                stop_reason: "tool_use",
                stop_details: null,
                content: [
                  { type: "text", text: "Hello" },
                  { type: "tool_use", id: "toolu_1", name: "search_nest", input: { query: "gate" } },
                ],
              }
            : { stop_reason: "end_turn", stop_details: null },
      };
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
  return await import("../src/hootie/model.js");
}

async function collect(gen: AsyncGenerator<string>) {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

const base = {
  apiKey: "sk-ant-test",
  baseUrl: null,
  system: "You are Hootie.",
  turns: [{ role: "user" as const, content: "hi" }],
};

beforeEach(() => {
  calls = [];
  rejectsTuned = new Set();
  alwaysFail = null;
  rejectsTools = new Set();
  replyWithToolUse = false;
});

const searchTool = {
  name: "search_nest",
  description: "Search the nest.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

/** Drain a round: its text, and what it returned. */
async function round(gen: AsyncGenerator<string, any>) {
  let text = "";
  let next = await gen.next();
  while (!next.done) {
    text += next.value;
    next = await gen.next();
  }
  return { text, result: next.value };
}

describe("streamRound — tools (ticket B)", () => {
  it("offers the tools, and returns the calls the round ended on with its content verbatim", async () => {
    replyWithToolUse = true;
    const { streamRound } = await load();
    const { text, result } = await round(
      streamRound({ ...base, messages: base.turns, model: "claude-opus-5", tools: [searchTool], toolChoice: "auto" }),
    );
    expect(text).toBe("Hello");
    expect(calls[0].params.tools).toEqual([searchTool]);
    expect(calls[0].params.tool_choice).toEqual({ type: "auto" });
    expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "search_nest", input: { query: "gate" } }]);
    expect(result.assistant).toHaveLength(2);
  });

  it("the last round goes out with tool_choice none; no tools → no tool fields at all", async () => {
    const { streamRound } = await load();
    await round(streamRound({ ...base, messages: base.turns, model: "claude-opus-5", tools: [searchTool], toolChoice: "none" }));
    expect(calls[0].params.tool_choice).toEqual({ type: "none" });
    calls = [];
    await round(streamRound({ ...base, messages: base.turns, model: "claude-opus-5" }));
    expect(calls[0].params).not.toHaveProperty("tools");
    expect(calls[0].params).not.toHaveProperty("tool_choice");
  });

  it("a gateway that refuses tools → ToolsRejectedError (after the bare retry); remembered once a tool-less request works", async () => {
    rejectsTools.add("gw/llama");
    const { streamRound, ToolsRejectedError } = await load();
    const ask = (tools?: unknown[]) =>
      round(streamRound({ ...base, messages: base.turns, model: "gw/llama", ...(tools ? { tools: tools as any } : {}) }));
    await expect(ask([searchTool])).rejects.toBeInstanceOf(ToolsRejectedError);
    // Tuned, then bare — both with tools.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => Array.isArray(c.params.tools))).toBe(true);
    // Without tools it answers …
    calls = [];
    expect((await ask()).text).toBe("Hello");
    // … so from now on a request with tools isn't even sent.
    calls = [];
    await expect(ask([searchTool])).rejects.toBeInstanceOf(ToolsRejectedError);
    expect(calls).toHaveLength(0);
    // Other models still get tools.
    await round(streamRound({ ...base, messages: base.turns, model: "claude-opus-5", tools: [searchTool] }));
    expect(calls[0].params.tools).toEqual([searchTool]);
  });

  it("a 400 that isn't about tools (it fails without them too) is not remembered as tool-less", async () => {
    alwaysFail = { status: 400, message: "Your credit balance is too low to access the Anthropic API." };
    const { streamRound, ToolsRejectedError } = await load();
    await expect(
      round(streamRound({ ...base, messages: base.turns, model: "claude-opus-5", tools: [searchTool] })),
    ).rejects.toBeInstanceOf(ToolsRejectedError);
    await expect(round(streamRound({ ...base, messages: base.turns, model: "claude-opus-5" }))).rejects.toMatchObject({
      status: 400,
    });
    alwaysFail = null;
    calls = [];
    await round(streamRound({ ...base, messages: base.turns, model: "claude-opus-5", tools: [searchTool] }));
    expect(calls).toHaveLength(1);
    expect(calls[0].params.tools).toEqual([searchTool]);
  });
});

describe("streamAnswer — model compatibility", () => {
  it("sends adaptive thinking + effort, and never sampling parameters", async () => {
    const { streamAnswer } = await load();
    expect(await collect(streamAnswer({ ...base, model: "claude-opus-5" }))).toBe("Hello");
    expect(calls).toHaveLength(1);
    const p = calls[0].params;
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "medium" });
    // Current Claude models 400 on these; nothing here may send them.
    for (const k of ["temperature", "top_p", "top_k"]) expect(p).not.toHaveProperty(k);
  });

  it("a model that rejects thinking/effort still answers, via the bare request", async () => {
    rejectsTuned.add("claude-haiku-4-5");
    const { streamAnswer } = await load();
    expect(await collect(streamAnswer({ ...base, model: "claude-haiku-4-5" }))).toBe("Hello");
    expect(calls).toHaveLength(2);
    const bare = calls[1].params;
    expect(bare).not.toHaveProperty("thinking");
    expect(bare).not.toHaveProperty("output_config");
    // Bare means bare: a plain string system, nothing a gateway could choke on.
    expect(bare.system).toBe("You are Hootie.");
  });

  it("remembers the plain model, so the next question costs one request", async () => {
    rejectsTuned.add("ollama/llama3.2");
    const { streamAnswer } = await load();
    await collect(streamAnswer({ ...base, model: "ollama/llama3.2" }));
    calls = [];
    expect(await collect(streamAnswer({ ...base, model: "ollama/llama3.2" }))).toBe("Hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].params).not.toHaveProperty("thinking");
    // …and only that model: others still get the tuned request.
    calls = [];
    await collect(streamAnswer({ ...base, model: "claude-opus-5" }));
    expect(calls[0].params.thinking).toEqual({ type: "adaptive" });
  });

  it("a 400 that fails both ways surfaces, and doesn't mark the model plain", async () => {
    // Out of credit is a 400 too. It must reach the panel as itself — and
    // once credit is added, the model must get its tuned request back.
    alwaysFail = { status: 400, message: "Your credit balance is too low to access the Anthropic API." };
    const { streamAnswer, describeModelError } = await load();
    let caught: unknown;
    try {
      await collect(streamAnswer({ ...base, model: "claude-opus-5" }));
    } catch (err) {
      caught = err;
    }
    expect(describeModelError(caught)).toMatch(/out of credit/i);
    // LiteLLM's 400 for a model it doesn't serve names the model that was asked for.
    const unknownModel = { status: 400, error: { error: { message: "litellm.BadRequestError: There are no healthy deployments for this model." } } };
    expect(describeModelError(unknownModel, { model: "default-claude/x", gateway: true })).toMatch(
      'No model named "default-claude/x"',
    );

    alwaysFail = null;
    calls = [];
    await collect(streamAnswer({ ...base, model: "claude-opus-5" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].params.thinking).toEqual({ type: "adaptive" });
  });

  it("anything other than a 400 is not retried", async () => {
    alwaysFail = { status: 401, message: "invalid x-api-key" };
    const { streamAnswer } = await load();
    await expect(collect(streamAnswer({ ...base, model: "claude-opus-5" }))).rejects.toMatchObject({
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("streamAnswer — logs", () => {
  it("always logs a summary, and the nest content only with HOOTIE_DEBUG_LOG", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      delete process.env.HOOTIE_DEBUG_LOG;
      let { streamAnswer } = await load();
      await collect(streamAnswer({ ...base, model: "claude-opus-5", system: "SECRET-DOC" }));
      let out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("[hootie] → request model=claude-opus-5");
      expect(out).toContain("[hootie] ← response");
      expect(out).not.toContain("SECRET-DOC");
      expect(out).not.toContain("sk-ant-test");

      log.mockClear();
      process.env.HOOTIE_DEBUG_LOG = "true";
      ({ streamAnswer } = await load());
      await collect(streamAnswer({ ...base, model: "claude-opus-5", system: "SECRET-DOC" }));
      out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("SECRET-DOC");
      expect(out).not.toContain("sk-ant-test");
    } finally {
      delete process.env.HOOTIE_DEBUG_LOG;
      log.mockRestore();
    }
  });
});

describe("describeModelError — where to fix it", () => {
  it("points admins at the Server settings tab that holds the model and key", async () => {
    const { describeModelError } = await load();
    for (const status of [401, 404]) {
      expect(describeModelError({ status }, { model: "gpt-4" })).toContain("Server settings → Hootie");
    }
  });
});
