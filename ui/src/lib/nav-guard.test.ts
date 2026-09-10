import { describe, it, expect, afterEach } from "vitest";
import { setNavGuard, navigateGuarded, bypassNavGuard } from "./nav-guard";

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
