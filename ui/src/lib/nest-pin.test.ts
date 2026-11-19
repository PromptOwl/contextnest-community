/**
 * Pinned ("starred") nests in the left rail (PO-1441): the order the rail
 * draws, and the optimistic toggle every pin control shares.
 */
import { describe, it, expect, vi } from "vitest";
import { railNestRows, withNestPinned, toggleNestPin, createPinGuard } from "./nest-pin";

const nest = (id: string, name: string, pinned = false) => ({ id, name, pinned });

describe("railNestRows — the rail's nest order", () => {
  const list = [
    nest("a", "Alpha"),
    nest("e", "Echo", true),
    nest("c", "Charlie"),
    nest("b", "Bravo", true),
    nest("d", "Delta"),
  ];
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  it("puts pinned nests first (by name), then the rest by name", () => {
    expect(ids(railNestRows(list, null, ""))).toEqual(["b", "e", "a", "c", "d"]);
  });

  it("keeps the current nest first among the unpinned ones (today's order)", () => {
    expect(ids(railNestRows(list, "d", ""))).toEqual(["b", "e", "d", "a", "c"]);
  });

  it("keeps the current nest first among the pinned ones when it is pinned", () => {
    expect(ids(railNestRows(list, "e", ""))).toEqual(["e", "b", "a", "c", "d"]);
  });

  it("with nothing pinned, is exactly today's order: current nest, then by name", () => {
    const plain = list.map((n) => ({ ...n, pinned: false }));
    expect(ids(railNestRows(plain, "c", ""))).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("filters by name and never filters out the current nest", () => {
    expect(ids(railNestRows(list, "a", "arl"))).toEqual(["a", "c"]);
    expect(ids(railNestRows(list, null, "o"))).toEqual(["b", "e"]);
  });

  it("does not reorder the cached list it was given", () => {
    const copy = list.map((n) => n.id);
    railNestRows(list, null, "");
    expect(list.map((n) => n.id)).toEqual(copy);
  });
});

describe("withNestPinned — patching the cached nest list", () => {
  it("flips one nest and leaves the rest untouched", () => {
    const prev = { nests: [nest("a", "A"), nest("b", "B", true)], other: 1 };
    const next = withNestPinned(prev, "a", true);
    expect(next).toEqual({ nests: [nest("a", "A", true), nest("b", "B", true)], other: 1 });
    expect(next!.nests[1]).toBe(prev.nests[1]);
  });

  it("passes an empty cache through", () => {
    expect(withNestPinned(undefined, "a", true)).toBeUndefined();
  });
});

describe("toggleNestPin — optimistic, with rollback", () => {
  it("patches the cache before the request lands", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const request = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const pending = toggleNestPin({
      nestId: "a",
      pinned: true,
      patch: (v) => calls.push(`patch:${v}`),
      request,
      onError: () => calls.push("error"),
    });
    expect(calls).toEqual(["patch:true"]);
    expect(request).toHaveBeenCalledWith("a", true);
    release();
    await expect(pending).resolves.toBe(true);
    expect(calls).toEqual(["patch:true"]);
  });

  it("rolls the patch back and reports the error when the request fails", async () => {
    const calls: string[] = [];
    const ok = await toggleNestPin({
      nestId: "a",
      pinned: false,
      patch: (v) => calls.push(`patch:${v}`),
      request: async () => {
        throw new Error("boom");
      },
      onError: (err) => calls.push(`error:${(err as Error).message}`),
    });
    expect(ok).toBe(false);
    expect(calls).toEqual(["patch:false", "patch:true", "error:boom"]);
  });
});

describe("createPinGuard — one in-flight write per nest across every control", () => {
  it("refuses a second claim on the same nest (rail, then header) until released", () => {
    const guard = createPinGuard();
    const seen: number[] = [];
    guard.subscribe(() => seen.push(guard.snapshot().size));
    expect(guard.claim("a")).toBe(true);
    expect(guard.claim("a")).toBe(false);
    expect(guard.claim("b")).toBe(true);
    expect([...guard.snapshot()].sort()).toEqual(["a", "b"]);
    guard.release("a");
    expect(guard.claim("a")).toBe(true);
    expect(seen).toEqual([1, 2, 1, 2]);
  });

  it("hands out a new snapshot on every change, so subscribers re-render", () => {
    const guard = createPinGuard();
    const before = guard.snapshot();
    guard.claim("a");
    expect(guard.snapshot()).not.toBe(before);
    const held = guard.snapshot();
    guard.claim("a"); // refused: no change, same snapshot
    expect(guard.snapshot()).toBe(held);
  });
});
