import { describe, it, expect } from "vitest";
import { updateToAnnounce } from "./update-status";

const status = (latest: string | null, update_available: boolean) =>
  ({ enabled: true, current: "2.3.0", latest, update_available, checked_at: null, install: "npm", command: "" }) as const;

describe("updateToAnnounce", () => {
  it("announces a newer release", () => {
    expect(updateToAnnounce(status("2.4.0", true), null)).toBe("2.4.0");
  });
  it("stays quiet when up to date or not checked yet", () => {
    expect(updateToAnnounce(status("2.3.0", false), null)).toBeNull();
    expect(updateToAnnounce(status(null, false), null)).toBeNull();
    expect(updateToAnnounce(undefined, null)).toBeNull();
  });
  it("a dismissal holds until the next release", () => {
    expect(updateToAnnounce(status("2.4.0", true), "2.4.0")).toBeNull();
    expect(updateToAnnounce(status("2.5.0", true), "2.4.0")).toBe("2.5.0");
  });
});
