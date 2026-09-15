/**
 * A flag that reads true exactly once after being armed, then resets itself.
 * Used where a synchronous side effect needs to skip its next run following
 * some triggering event, without waiting for a batched state update to land
 * first — e.g. NestView's Escape-to-cancel-rename, where reverting the input
 * via setState and calling .blur() in the same handler fires the input's
 * onBlur (and whatever it flushes) before React applies that state update.
 */
export function createConsumeOnceFlag() {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    consume: (): boolean => {
      if (!armed) return false;
      armed = false;
      return true;
    },
  };
}
