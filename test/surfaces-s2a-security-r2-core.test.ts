/**
 * Surfaces S2a security round 2 — pure parts: what a card may say when the
 * room holds non-readers (H1) and the single listener-tie predicate (INFO).
 */
import { describe, it, expect } from "vitest";
import * as cardText from "../src/surfaces/core/card-text.js";
const { fixedCardText } = cardText;
import { isTiedListenerConfig } from "../src/surfaces/core/listener-tie.js";

describe("N1 card text (pure)", () => {
  it("N1: no window-token heuristic is left to beat", () => {
    expect(Object.keys(cardText).sort()).toEqual(["fixedCardText"]);
  });
  it("N1: every kind gets a fixed sentence naming only the kind and the nest", () => {
    expect(fixedCardText([{ kind: "decision", op: "new" }], "Acme")).toEqual({ title: "A proposed decision from this conversation is waiting for review in Acme", summary: "" });
    expect(fixedCardText([{ kind: "correction", op: "edit" }], "Acme").title).toBe("A proposed correction from this conversation is waiting for review in Acme");
    expect(fixedCardText([{ kind: "owner_deadline", op: "new" }], "Acme").title).toBe("A proposed commitment from this conversation is waiting for review in Acme");
    expect(fixedCardText([{ kind: "fact", op: "new" }, { kind: "decision", op: "new" }], "Acme").title).toBe("2 proposals from this conversation are waiting for review in Acme");
  });
});

describe("INFO: one listener-tie predicate", () => {
  const base = { surfaces_listener: { binding_id: "b1" }, feeds: [], mcp_servers: [], notify: { recipients: [], channels: [] } };
  it("INFO: tied only when disabled, marked for this binding, and with no feeds, MCP or notify", () => {
    expect(isTiedListenerConfig(base, 0, "b1")).toBe(true);
    expect(isTiedListenerConfig(base, 1, "b1")).toBe(false);
    expect(isTiedListenerConfig(base, 0, "b2")).toBe(false);
    expect(isTiedListenerConfig({ ...base, notify: { recipients: [], channels: ["email"] } }, 0, "b1")).toBe(false);
    expect(isTiedListenerConfig({ ...base, notify: { recipients: ["owner"], channels: [] } }, 0, "b1")).toBe(false);
    expect(isTiedListenerConfig({ ...base, feeds: [{}] }, 0, "b1")).toBe(false);
    expect(isTiedListenerConfig(null, 0, "b1")).toBe(false);
  });
});
