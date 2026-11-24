import { prettyFolderPath } from "./FolderTree";
import { SearchableSelect, type SearchableOption } from "./SearchableSelect";

/** The nest root's row: a list item needs a non-empty value, and no folder path is "/". */
const ROOT = "/";

/** Nest root first, then every folder once, by path. */
export function folderChoices(folders: readonly string[], current?: string): SearchableOption[] {
  const paths = [...new Set([...folders, current ?? ""])].filter((f) => f && f !== "Root").sort();
  return [{ value: ROOT, label: "Nest root" }, ...paths.map((f) => ({ value: f, label: prettyFolderPath(f) }))];
}

/** One folder of the nest, searchable by name or path. "" is the nest root. */
export function FolderSelect({
  value,
  onChange,
  folders,
  extra = [],
  disabled,
  testId,
}: {
  value: string;
  onChange: (folder: string) => void;
  folders: readonly string[];
  /** Rows after the folders, e.g. "New folder…". */
  extra?: SearchableOption[];
  disabled?: boolean;
  testId?: string;
}) {
  const inExtra = extra.some((o) => o.value === value);
  return (
    <SearchableSelect
      ariaLabel="Folder"
      value={value || ROOT}
      onChange={(v) => onChange(v === ROOT ? "" : v)}
      options={[...folderChoices(folders, inExtra ? undefined : value), ...extra]}
      searchPlaceholder="Search folders…"
      emptyText="No folders match."
      disabled={disabled}
      testId={testId}
    />
  );
}
