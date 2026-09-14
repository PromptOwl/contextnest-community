/**
 * Notifications strip preview: how many of the fetched notifications render,
 * and that clearing one never shrinks the reachable set below what the
 * caller already asked to see.
 */
import { describe, it, expect } from "vitest";
import {
  NOTIFICATIONS_PREVIEW_COUNT,
  visibleNotifications,
} from "./notifications-preview";

const notifications = Array.from({ length: 42 }, (_, i) => ({ id: `n${i}` }));

describe("visibleNotifications", () => {
  it("caps the collapsed view at the preview count", () => {
    expect(visibleNotifications(notifications, false)).toHaveLength(
      NOTIFICATIONS_PREVIEW_COUNT,
    );
  });

  it("returns every notification once expanded, however many the server sent", () => {
    expect(visibleNotifications(notifications, true)).toHaveLength(42);
  });

  it("does not slice at all when the whole list already fits under the cap", () => {
    const short = notifications.slice(0, 5);
    expect(visibleNotifications(short, false)).toEqual(short);
    expect(visibleNotifications(short, true)).toEqual(short);
  });

  it("honors a custom preview count", () => {
    expect(visibleNotifications(notifications, false, 3)).toHaveLength(3);
  });
});
