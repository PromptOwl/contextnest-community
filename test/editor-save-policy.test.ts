import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSavePolicy } from "../ui/src/components/MarkdownEditor/savePolicy";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("save policy — versioning guardrail (T1)", () => {
  it("keystrokes never cut a checkpoint; one debounced draft fires", () => {
    const onDraft = vi.fn();
    const onCheckpoint = vi.fn();
    const p = createSavePolicy({ onDraft, onCheckpoint, draftDebounceMs: 800, idleMs: 30000 });

    for (const s of ["a", "ab", "abc"]) p.change(s);
    vi.advanceTimersByTime(800); // debounce window only — well under idle

    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledWith("abc");
    expect(onCheckpoint).toHaveBeenCalledTimes(0);
  });

  it("blur with changes cuts exactly one checkpoint", () => {
    const onCheckpoint = vi.fn();
    const p = createSavePolicy({ onDraft: vi.fn(), onCheckpoint });

    p.change("hello");
    expect(p.blur()).toBe(true);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint).toHaveBeenCalledWith("hello");
  });

  it("coalesces: a second boundary with no new edits cuts nothing", () => {
    const onCheckpoint = vi.fn();
    const p = createSavePolicy({ onDraft: vi.fn(), onCheckpoint });

    p.change("x");
    expect(p.blur()).toBe(true); // 1
    expect(p.blur()).toBe(false); // no new edits → no-op
    expect(p.explicitSave()).toBe(false);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("idle beyond idleMs cuts a checkpoint while focused", () => {
    const onCheckpoint = vi.fn();
    const p = createSavePolicy({ onDraft: vi.fn(), onCheckpoint, idleMs: 30000 });

    p.change("draft text");
    vi.advanceTimersByTime(30000);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint).toHaveBeenCalledWith("draft text");
  });

  it("explicit save (Cmd+S) checkpoints, then re-editing the same checkpoint is dirty again only on change", () => {
    const onCheckpoint = vi.fn();
    const p = createSavePolicy({ onDraft: vi.fn(), onCheckpoint });

    p.change("v1");
    expect(p.explicitSave()).toBe(true); // checkpoint v1
    p.change("v1"); // same content → not dirty
    expect(p.blur()).toBe(false);
    p.change("v2"); // real edit
    expect(p.navigateAway()).toBe(true); // checkpoint v2
    expect(onCheckpoint).toHaveBeenCalledTimes(2);
  });
});
