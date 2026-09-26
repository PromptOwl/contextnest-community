import { describe, it, expect } from "vitest";
import { personComboboxEnterAction } from "./person-combobox";

describe("personComboboxEnterAction", () => {
  it("submits when the list is closed", () => {
    expect(personComboboxEnterAction(false, 0, -1)).toEqual({
      type: "submit",
    });
  });

  it("submits when the list is open but empty", () => {
    expect(personComboboxEnterAction(true, 0, -1)).toEqual({
      type: "submit",
    });
  });

  it("submits when the list is open with matches but nothing is highlighted", () => {
    // This is the Enter-to-add-a-typed-address case — the dropdown must
    // close so a since-cleared field doesn't reopen it against an empty
    // query (the reported bug).
    expect(personComboboxEnterAction(true, 3, -1)).toEqual({
      type: "submit",
    });
  });

  it("picks the highlighted option when one is highlighted", () => {
    expect(personComboboxEnterAction(true, 3, 1)).toEqual({
      type: "pick",
      index: 1,
    });
  });

  it("submits when the highlighted index no longer fits the narrowed list", () => {
    expect(personComboboxEnterAction(true, 2, 5)).toEqual({
      type: "submit",
    });
  });
});
