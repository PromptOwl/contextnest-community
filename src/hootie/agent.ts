/**
 * Hootie's answer loop: model rounds with tools until it answers.
 *
 * Each round streams through model.ts (the only module that talks to the
 * SDK). A round that ends in tool calls runs them — each one counted against
 * the question's cap, reported to the panel as a status, and fed back as a
 * tool result — and asks again. Once the cap is spent the next round goes out
 * with tool_choice "none": the model must answer with what it has. A request
 * that has been hung up on makes no further model call and runs no tool.
 *
 * Text the model writes in a round that ends in a tool call is it thinking
 * aloud before searching, not the answer: the status event that follows
 * tells the client to drop it, and the route does the same.
 */
import { streamRound, type ModelMessage, type ModelTurn, type ToolSpec } from "./model.js";
import type { HootieTool } from "./tools.js";

export type AgentEvent =
  | { type: "text"; text: string }
  /** A tool is about to run. Supersedes any text sent since the last one. */
  | { type: "status"; tool: string; text: string; input: unknown };

export interface AgentParams {
  apiKey: string;
  model: string;
  baseUrl?: string | null;
  system: string;
  turns: ModelTurn[];
  tools: HootieTool[];
  /** Tool calls this question may make in all. */
  maxCalls: number;
  signal: AbortSignal;
}

export async function* runAgent(params: AgentParams): AsyncGenerator<AgentEvent> {
  const { tools, signal } = params;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs: ToolSpec[] = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const messages: ModelMessage[] = params.turns.map((t) => ({ ...t }));
  let calls = 0;
  for (;;) {
    if (signal.aborted) return;
    const spent = calls >= params.maxCalls;
    const round = streamRound({
      apiKey: params.apiKey,
      model: params.model,
      baseUrl: params.baseUrl,
      system: params.system,
      messages,
      signal,
      ...(specs.length ? { tools: specs, toolChoice: spent ? "none" : "auto" } : {}),
    });
    let next = await round.next();
    while (!next.done) {
      if (signal.aborted) return;
      yield { type: "text", text: next.value };
      next = await round.next();
    }
    const { toolCalls, assistant } = next.value;
    // No calls, or calls we won't run any more (a model or gateway that
    // ignored tool_choice "none"): what it wrote is the answer.
    if (toolCalls.length === 0 || spent || specs.length === 0) return;

    messages.push({ role: "assistant", content: assistant });
    const results: unknown[] = [];
    for (const call of toolCalls) {
      if (signal.aborted) return;
      const tool = byName.get(call.name);
      let content: string;
      let isError = false;
      if (!tool) {
        content = `There is no tool named ${call.name}.`;
        isError = true;
      } else if (calls >= params.maxCalls) {
        content = "No more searches for this question. Answer with the documents you have.";
        isError = true;
      } else {
        calls++;
        yield { type: "status", tool: tool.name, text: tool.status(call.input), input: call.input };
        if (signal.aborted) return;
        try {
          ({ content, isError = false } = await tool.run(call.input, signal));
        } catch (err) {
          console.error(`[hootie] tool ${call.name} failed`, err);
          content = `${call.name} failed. Answer with the documents you have.`;
          isError = true;
        }
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    }
    if (signal.aborted) return;
    messages.push({ role: "user", content: results });
  }
}
