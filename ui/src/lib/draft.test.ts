import { describe, it, expect, beforeEach } from "vitest";
import { readDraft, writeDraft, clearDraft, draftKey } from "./draft";

/** Minimal localStorage with a byte budget, so quota eviction is exercisable. */
function installStorage(maxBytes = Infinity) {
  const map = new Map<string, string>();
  const size = () =>
    [...map.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const store = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => {
      const prev = map.get(k);
      map.set(k, v);
      if (size() > maxBytes) {
        if (prev === undefined) map.delete(k);
        else map.set(k, prev);
        throw new Error("QuotaExceededError");
      }
    },
  };
  (globalThis as any).localStorage = store;
  return map;
}

const body = (n: number) => ({
  title: "T",
  content: "x".repeat(n),
  tags: ["a"],
  schedule: "",
});

describe("document drafts", () => {
  beforeEach(() => installStorage());

  it("round-trips a large draft", () => {
    // ~6 pages of prose.
    const big = body(200_000);
    expect(writeDraft("n1", "nodes/doc", { ...big, baseVersion: 3 })).toBe(true);
    const back = readDraft("n1", "nodes/doc");
    expect(back?.content).toHaveLength(200_000);
    expect(back?.baseVersion).toBe(3);
    expect(back?.savedAt).toBeGreaterThan(0);
  });

  it("clearDraft removes it", () => {
    writeDraft("n1", "nodes/doc", body(10));
    clearDraft("n1", "nodes/doc");
    expect(readDraft("n1", "nodes/doc")).toBeNull();
  });

  it("evicts the stalest other draft to fit the one being edited", () => {
    // Budget fits the new draft plus one of the two seeded ones, not both.
    const map = installStorage(900);
    map.set(
      draftKey("n1", "old"),
      JSON.stringify({ ...body(200), savedAt: 100 }),
    );
    map.set(
      draftKey("n1", "newer"),
      JSON.stringify({ ...body(200), savedAt: 900 }),
    );

    expect(writeDraft("n1", "current", body(400))).toBe(true);
    expect(readDraft("n1", "current")?.content).toHaveLength(400);
    expect(readDraft("n1", "old")).toBeNull(); // stalest went first
    expect(readDraft("n1", "newer")).not.toBeNull();
  });

  it("reports failure when the draft can't fit even alone", () => {
    installStorage(100);
    expect(writeDraft("n1", "current", body(5_000))).toBe(false);
    expect(readDraft("n1", "current")).toBeNull();
  });

  it("reports failure when storage is unavailable", () => {
    (globalThis as any).localStorage = {
      get length(): number {
        throw new Error("blocked");
      },
      key() {
        throw new Error("blocked");
      },
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(writeDraft("n1", "current", body(10))).toBe(false);
    expect(readDraft("n1", "current")).toBeNull();
    expect(() => clearDraft("n1", "current")).not.toThrow();
  });
});
