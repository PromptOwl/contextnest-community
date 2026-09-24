import { describe, it, expect } from "vitest";
import {
  removeCollaboratorConfirmCopy,
  removeCollaboratorSuccessMessage,
} from "./collaborator-confirm";

describe("removeCollaboratorConfirmCopy", () => {
  it("names the collaborator and the nest", () => {
    const c = removeCollaboratorConfirmCopy("alex@example.com", "Roadmap");
    expect(c.body).toContain("alex@example.com");
    expect(c.body).toContain("Roadmap");
    expect(c.confirm.length).toBeGreaterThan(0);
  });

  it("falls back to a generic label when the collaborator has no email", () => {
    const c = removeCollaboratorConfirmCopy(undefined, "Roadmap");
    expect(c.body).toContain("this collaborator");
  });

  it("reassures that only nest access is revoked, not the account", () => {
    const c = removeCollaboratorConfirmCopy("alex@example.com", "Roadmap");
    expect(c.body).toMatch(/keep their account/i);
  });
});

describe("removeCollaboratorSuccessMessage", () => {
  it("names the removed collaborator", () => {
    expect(removeCollaboratorSuccessMessage("alex@example.com")).toContain(
      "alex@example.com",
    );
  });

  it("falls back to a generic label when the collaborator has no email", () => {
    expect(removeCollaboratorSuccessMessage(undefined)).toContain("Collaborator");
  });
});
