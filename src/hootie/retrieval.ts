/**
 * What Hootie has retrieved for one question, across every round — the open
 * document, the question, and any searches the model ran — de-duplicated by
 * id, in the order it arrived. Everything here came through resolveContext
 * as the caller, so it is exactly what this person may read; citations
 * resolve against `nodes` and nothing else.
 */
import {
  approxTokens,
  type ContextNodeSummary,
  type ContextResult,
} from "../nodes/context-service.js";
import { artifactText, isHtmlBody, trimToTokens } from "./artifact-text.js";

export type ContextBlock = ContextResult["blocks"][number];

/**
 * A retrieved block as the model gets it. An HTML page (an artifact) is
 * reduced to its visible text — the model reads what the person sees, not
 * the scripts and styles around it. With `maxTokens`, the block is cut to
 * that size with a visible marker rather than left out.
 */
export function modelBlock(block: ContextBlock, maxTokens?: number): string {
  let body = block.body;
  if (isHtmlBody(block.type, body)) body = artifactText(body);
  if (maxTokens !== undefined) {
    body = trimToTokens(body, Math.max(50, maxTokens - approxTokens(block.header))).text;
  }
  return block.header + body;
}

/** A document can't close the <documents> fence and speak as instructions. */
export function defuseFence(text: string): string {
  return text.replace(/<\/documents>/gi, "</ documents>");
}

export class Gathered {
  readonly nodes: ContextNodeSummary[] = [];
  readonly blocks: string[] = [];
  private readonly seen = new Set<string>();

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Add one node with its (already model-shaped) block; false if known. */
  add(node: ContextNodeSummary, block: string): boolean {
    if (this.seen.has(node.id)) return false;
    this.seen.add(node.id);
    this.nodes.push(node);
    this.blocks.push(block);
    return true;
  }

  /** Add a retrieval's results. Returns what was new and what was already
   *  here, so a search can tell the model only what it hasn't seen. */
  take(r: ContextResult): { added: Array<{ node: ContextNodeSummary; block: string }>; repeated: ContextNodeSummary[] } {
    const added: Array<{ node: ContextNodeSummary; block: string }> = [];
    const repeated: ContextNodeSummary[] = [];
    for (let i = 0; i < r.nodes.length; i++) {
      const n = r.nodes[i];
      const block = modelBlock(r.blocks[i]);
      if (this.add(n, block)) added.push({ node: n, block });
      else repeated.push(n);
    }
    return { added, repeated };
  }
}
