import { describe, it, expect } from "vitest";
import { createConsumeOnceFlag } from "./consume-once-flag";

describe("createConsumeOnceFlag", () => {
  it("consume() is false until armed", () => {
    const flag = createConsumeOnceFlag();
    expect(flag.consume()).toBe(false);
  });

  it("consume() reads true exactly once after arm(), then resets", () => {
    const flag = createConsumeOnceFlag();
    flag.arm();
    expect(flag.consume()).toBe(true);
    expect(flag.consume()).toBe(false);
  });

  it("arming again after a consume works the same way", () => {
    // Mirrors pressing Escape twice in NestView's rename input: each press
    // should skip exactly one flushRename, not leave it permanently skipped
    // or permanently armed.
    const flag = createConsumeOnceFlag();
    flag.arm();
    expect(flag.consume()).toBe(true);
    flag.arm();
    expect(flag.consume()).toBe(true);
    expect(flag.consume()).toBe(false);
  });
});
