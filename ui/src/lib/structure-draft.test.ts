import { describe, it, expect } from "vitest";
import { cleanFolder, folderPatterns, removeFolder, renameFolder, renameTemplate, sameRules, setFolder } from "./structure-draft";

describe("structure draft", () => {
  const draft = {
    folders: {
      "clients/{client}": { folder_name: "/[a-z]+-[0-9]{3}/", files: { overview: { template: "o" } } },
      decisions: { file_name: "adr-{n}-{slug}", template: "o" },
    },
    templates: { o: { body: "## Summary\n", required_sections: ["Summary"] } },
  };

  it("drops empty fields so the saved rules stay what the owner set", () => {
    expect(cleanFolder({ file_name: " ", types: [], required: false, files: {}, template: "" })).toEqual({});
    expect(setFolder(draft, "decisions", { file_name: "" }).folders!.decisions).toEqual({ template: "o" });
  });

  it("renames a rule in place, and refuses a name another rule has", () => {
    const next = renameFolder(draft, "decisions", "adrs")!;
    expect(Object.keys(next.folders!)).toEqual(["clients/{client}", "adrs"]);
    expect(renameFolder(draft, "decisions", "clients/{client}")).toBeNull();
  });

  it("renaming a template follows the rules and required files that use it", () => {
    const next = renameTemplate(draft, "o", "overview")!;
    expect(next.folders!.decisions!.template).toBe("overview");
    expect(next.folders!["clients/{client}"]!.files!.overview!.template).toBe("overview");
  });

  it("lists rules by path and tells a real change from a reordering", () => {
    expect(folderPatterns(draft)).toEqual(["clients/{client}", "decisions"]);
    const reordered = { templates: draft.templates, folders: { decisions: draft.folders.decisions, "clients/{client}": draft.folders["clients/{client}"] } };
    expect(sameRules(draft, reordered)).toBe(true);
    expect(sameRules(draft, removeFolder(draft, "decisions"))).toBe(false);
  });
});
