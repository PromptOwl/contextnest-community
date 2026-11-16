/**
 * copyText's hidden-textarea fallback — the path Safari takes when the async
 * Clipboard API is missing (plain HTTP) or refuses the write.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function fakeDom({ dialogOpen }: { dialogOpen: boolean }) {
  const calls: string[] = [];
  const node = (name: string) => ({
    name,
    children: [] as any[],
    appendChild(c: any) {
      this.children.push(c);
      c.parent = this;
    },
    removeChild(c: any) {
      this.children = this.children.filter((x: any) => x !== c);
    },
  });
  const body = node("body");
  const dialog = node("dialog");
  const trigger = { focus: () => calls.push("refocus") };
  const ta: any = {
    style: {},
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
    setSelectionRange: (a: number, b: number) => calls.push(`range ${a}-${b}`),
  };
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", {
    body,
    activeElement: trigger,
    createElement: () => ta,
    querySelectorAll: () => (dialogOpen ? [dialog] : []),
    execCommand: (cmd: string) => {
      calls.push(`exec ${cmd} in ${ta.parent?.name}`);
      return true;
    },
  });
  return { calls, ta, body, dialog };
}

afterEach(() => vi.unstubAllGlobals());

describe("copyText fallback", () => {
  it("copies from inside the open dialog, with an explicit selection range", async () => {
    const { calls, ta, dialog } = fakeDom({ dialogOpen: true });
    expect(await copyText("hello")).toBe(true);
    expect(calls).toEqual([
      "focus",
      "select",
      "range 0-5",
      "exec copy in dialog",
      "refocus",
    ]);
    expect(ta.attrs.readonly).toBe("");
    expect(dialog.children).toEqual([]);
  });

  it("falls back to <body> when no dialog is open", async () => {
    const { calls, body } = fakeDom({ dialogOpen: false });
    expect(await copyText("x")).toBe(true);
    expect(calls).toContain("exec copy in body");
    expect(body.children).toEqual([]);
  });
});
