import { describe, it, expect, afterEach, vi } from "vitest";
import { setNavGuard, navigateGuarded, bypassNavGuard, historyWriteMode, dropParkedEntries } from "./nav-guard";

afterEach(() => setNavGuard(null));

describe("navigateGuarded", () => {
  it("navigates straight through when no screen registered a guard", () => {
    let went = false;
    navigateGuarded(() => {
      went = true;
    });
    expect(went).toBe(true);
  });

  it("hands the navigation to a guard that takes it over", () => {
    let went = false;
    let held: (() => void) | null = null;
    setNavGuard((proceed) => {
      held = proceed;
      return true;
    });
    navigateGuarded(() => {
      went = true;
    });
    expect(went).toBe(false);
    held!();
    expect(went).toBe(true);
  });

  it("lets a navigation through when the guard declines it", () => {
    let went = false;
    setNavGuard(() => false);
    navigateGuarded(() => {
      went = true;
    });
    expect(went).toBe(true);
  });

  it("restores the guard when the bypassed navigation throws", () => {
    // A save's continuation runs inside bypassNavGuard. If onSaved throws and
    // the flag stuck, every later navigation would skip the guard and unsaved
    // edits would be dropped silently.
    let asked = 0;
    setNavGuard(() => {
      asked++;
      return true;
    });
    expect(() =>
      bypassNavGuard(() => {
        throw new Error("navigation failed");
      }),
    ).toThrow("navigation failed");
    navigateGuarded(() => {});
    expect(asked).toBe(1);
  });

  it("does not re-ask a guard about the navigation it already answered", () => {
    let asked = 0;
    let went = false;
    setNavGuard((proceed) => {
      asked++;
      // Answer immediately, the way the leave dialog's Discard does.
      bypassNavGuard(proceed);
      return true;
    });
    navigateGuarded(() => {
      went = true;
      // The screen's own handler navigates again inside the answer.
      navigateGuarded(() => {});
    });
    expect(went).toBe(true);
    expect(asked).toBe(1);
  });
});

describe("historyWriteMode", () => {
  it("replaces when neither side is looking at a node", () => {
    expect(historyWriteMode(null, null)).toBe("replace");
  });

  it("replaces on the first node a session lands on — nothing to come back to yet", () => {
    expect(historyWriteMode(null, "nest-1/doc-a")).toBe("replace");
  });

  it("replaces when the node hasn't actually changed", () => {
    expect(historyWriteMode("nest-1/doc-a", "nest-1/doc-a")).toBe("replace");
  });

  it("replaces when leaving a node for a non-node view (e.g. back to the nest overview)", () => {
    expect(historyWriteMode("nest-1/doc-a", null)).toBe("replace");
  });

  it("pushes when hopping from one node to a different node", () => {
    expect(historyWriteMode("nest-1/doc-a", "nest-1/doc-b")).toBe("push");
  });
});

// CU-wdqcq02g19: "sometimes going back ... takes me to the root nest instead
// of the last doc". App's URL-sync effect always replaceState'd, so browser
// history never grew an entry per document — Back skipped the whole in-app
// chain to whatever real entry preceded the session. This reproduces the
// wiki-link hop against a minimal stand-in for window.history (push/replace/
// back, the same semantics the real API gives App.tsx) driven by the actual
// production decision function, and proves Back lands on the previous
// document rather than the entry two hops back (the nest overview).
describe("browser Back after a wiki-link hop (CU-wdqcq02g19)", () => {
  it("returns to the previous document, not the root nest", () => {
    const stack: Array<{ key: string | null }> = [];
    let index = -1;
    let lastKey: string | null = null;
    const write = (key: string | null) => {
      if (historyWriteMode(lastKey, key) === "push") {
        stack.length = index + 1; // drop any forward entries, like a real push
        stack.push({ key });
        index++;
      } else {
        stack[index] = { key };
      }
      lastKey = key;
    };

    write(null); // nest overview
    write("nest-1/doc-a"); // open document A
    write("nest-1/doc-b"); // click a wiki-link to document B

    index--; // browser Back
    expect(stack[index].key).toBe("nest-1/doc-a");
  });

  // App keys entries by path + node, so page-to-page moves get a Back stop too.
  it("returns to the previous page, not out of the app", () => {
    const stack: string[] = [];
    let last: string | null = null;
    const write = (key: string) => {
      if (historyWriteMode(last, key) === "push") stack.push(key);
      else stack[Math.max(0, stack.length - 1)] = key;
      last = key;
    };
    write("/|"); // dashboard
    write("/nest/n1|"); // open nest
    write("/nest/n1/board|"); // board view
    expect(stack).toEqual(["/|", "/nest/n1|", "/nest/n1/board|"]);
  });

  it("reuses a parked leave-guard entry instead of pushing over it", () => {
    expect(historyWriteMode("/nest/n1|n1/doc-a", "/nest/n1|", false)).toBe("replace");
  });
});

describe("dropParkedEntries", () => {
  it("drops the spare entries when the editor turns clean in place", () => {
    vi.useFakeTimers();
    const history = { state: { cnLeaveGuard: true } as any, go: vi.fn() };
    dropParkedEntries(2, history);
    vi.runAllTimers();
    expect(history.go).toHaveBeenCalledWith(-2);
    vi.useRealTimers();
  });

  it("leaves history alone when App already navigated over the spare entry", () => {
    vi.useFakeTimers();
    const history = { state: { cnLeaveGuard: true } as any, go: vi.fn() };
    dropParkedEntries(1, history);
    // Save of a new document: App replaces the parked entry with the nest view
    // in the same commit, before the deferred drop runs.
    history.state = { page: "nest", nestId: "n1" };
    vi.runAllTimers();
    expect(history.go).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
