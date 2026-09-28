import { describe, it, expect } from "vitest";
import { displayNameFor } from "./person-name";

const people = [
  { email: "alan11345@swagpapa.com", name: "Alan11345" },
  { email: "nobody@acme.com", name: null },
];

describe("displayNameFor", () => {
  it("shows the display name instead of the email", () => {
    expect(displayNameFor("alan11345@swagpapa.com", people)).toBe("Alan11345");
  });
  it("matches the email case-insensitively", () => {
    expect(displayNameFor("Alan11345@SwagPapa.com", people)).toBe("Alan11345");
  });
  it("falls back to the email with no name, no match, or no roster", () => {
    expect(displayNameFor("nobody@acme.com", people)).toBe("nobody@acme.com");
    expect(displayNameFor("ghost@acme.com", people)).toBe("ghost@acme.com");
    expect(displayNameFor("ghost@acme.com")).toBe("ghost@acme.com");
  });
});
