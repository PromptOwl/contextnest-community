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
      const fail = alwaysFail
        ? apiError(alwaysFail.status, alwaysFail.message)
        : tuned && rejectsTuned.has(String(params.model))
          ? apiError(400, "thinking: adaptive thinking is not supported on this model")
          : null;
      return {
        async *[Symbol.asyncIterator]() {
          // A rejected request fails before any event, as the real API does.
          if (fail) throw fail;
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
        },
        finalMessage: async () => ({ stop_reason: "end_turn", stop_details: null }),
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
