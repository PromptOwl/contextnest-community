import yaml from "js-yaml";
import { splitFrontmatter } from "./instructions";

/**
 * A markdown file dropped into a nest (Import → Files / Whole vault) may open
 * with a YAML frontmatter block, as the dashboard's folder import already
 * understands. Pull its title and tags out and keep only the body
 * (CU-wdqcq0657f). Unparseable YAML leaves the file exactly as it was.
 */
export function importedMarkdown(raw: string): { title?: string; tags?: string[]; body: string } {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!frontmatter) return { body: raw };
  let fm: unknown;
  try {
    fm = yaml.load(frontmatter.replace(/^---\r?\n/, "").replace(/\r?\n---(?:\r?\n){0,2}$/, ""));
  } catch {
    return { body: raw };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return { body: raw };
  const { title, tags } = fm as { title?: unknown; tags?: unknown };
  const tagList = (Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [])
    .map((t) => String(t).trim())
    .filter(Boolean);
  return {
    ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
    ...(tagList.length ? { tags: tagList } : {}),
    body,
  };
}
