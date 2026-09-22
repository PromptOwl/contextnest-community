/**
 * Hootie's model call — the one place this server talks to Claude.
 *
 * Kept to a single streaming function with a plain-text contract so the route
 * (and its tests) never touch the SDK: tests replace this module with a
 * scripted generator and exercise everything else for real. The server-wide
 * ANTHROPIC_API_KEY that the superadmin sets for agent runners is the only
 * credential; there is no per-user key.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface ModelTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Stream the assistant's answer as text chunks.
 *
 * Adaptive thinking stays on (the model's default); effort is capped at
 * `medium` because a grounded Q&A over a few documents doesn't need more, and
 * a chat panel is latency-sensitive. `max_tokens` caps a runaway answer, not
 * a normal one: a cited chat reply is a few hundred tokens, and 4096 leaves
 * room for a long list without letting a loop run to the model's ceiling.
 * `signal` cancels the stream when the client hangs up.
 */
export async function* streamAnswer(params: {
  apiKey: string;
  model: string;
  system: string;
  turns: ModelTurn[];
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey: params.apiKey });
  const stream = client.messages.stream(
    {
      model: params.model,
      max_tokens: 4096,
      // The system prompt carries the retrieved context, which is the bulk of
      // the request and identical across a conversation's turns — cache it.
      system: [
        {
          type: "text",
          text: params.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: params.turns,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    },
    { signal: params.signal },
  );
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new ModelRefusedError(
      final.stop_details?.explanation || "The model declined to answer that.",
    );
  }
}

export class ModelRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRefusedError";
  }
}
