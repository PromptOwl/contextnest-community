import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchableSelect, optionMatches } from "./SearchableSelect";
import { NestSelect } from "../pages/app/control-room/SetupWizard";

const ops = { value: "deadbeef-0001", label: "Engineering Ops" };

describe("optionMatches", () => {
  it("matches any part of the label, whatever the case", () => {
    expect(optionMatches(ops, "ops")).toBe(true);
    expect(optionMatches(ops, " ENGIN ")).toBe(true);
    expect(optionMatches(ops, "sales")).toBe(false);
  });
  it("matches the value too, unless values are opaque ids", () => {
    expect(optionMatches(ops, "dead")).toBe(true);
    expect(optionMatches(ops, "dead", false)).toBe(false);
  });
  it("an unknown option never matches", () => {
    expect(optionMatches(undefined, "")).toBe(false);
  });
});

describe("po-1439: the Control Room nest picker is searchable", () => {
  const html = (value: string) =>
    renderToStaticMarkup(<NestSelect label="Nest for #general" value={value} nests={[{ id: ops.value, name: ops.label }]} onChange={() => {}} />);
  it("is a combobox named for its channel and showing the chosen nest", () => {
    expect(html(ops.value)).toContain('role="combobox"');
    expect(html(ops.value)).toContain('aria-label="Nest for #general: Engineering Ops"');
  });
  it("asks for a nest when the value is not in the list", () => {
    expect(html("gone")).toContain("Choose a nest");
  });
  it("keeps its default field width when no class is passed", () => {
    expect(renderToStaticMarkup(<SearchableSelect value="" onChange={() => {}} options={[]} />)).toContain("h-10 w-full");
  });
});
