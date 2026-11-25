import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderSelect, folderChoices } from "./FolderSelect";

describe("po-1207: folderChoices", () => {
  it("lists the nest root first, then each folder once", () => {
    expect(folderChoices(["second", "Root", "gtm/deals", "second"]).map((o) => o.label)).toEqual(["Nest root", "Gtm / Deals", "Second"]);
  });
  it("keeps the column's folder while the list is still loading", () => {
    expect(folderChoices([], "gtm").map((o) => o.value)).toContain("gtm");
  });
});

describe("po-1203: the folder picker in the move dialogs is searchable", () => {
  const html = (value: string, extra?: { value: string; label: string }[]) =>
    renderToStaticMarkup(<FolderSelect value={value} onChange={() => {}} folders={["gtm/deals"]} extra={extra} />);
  it("shows the chosen folder, the nest root for an empty path, and an extra row", () => {
    expect(html("gtm/deals")).toContain("Gtm / Deals");
    expect(html("")).toContain("Nest root");
    expect(html("__new__", [{ value: "__new__", label: "New folder…" }])).toContain("New folder…");
  });
  it.each(["./nest/DocumentsTab.tsx", "./nest/BulkSelectionBar.tsx", "./nest/FolderMoveDialog.tsx", "./DocumentEditor.tsx"])("%s uses it", (file) => {
    expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")).toContain("<FolderSelect");
  });
});
