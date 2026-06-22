/**
 * Markdown parsing utilities — extract tags, wiki links, mentions, tasks,
 * hyperlinks from prose. Ported from TheOwl lib/markdownParser.ts so both
 * repos use the same parser.
 *
 * The parser-output shapes (WikiLink, Mention, Task) intentionally differ
 * from the persisted entity shapes in either repo (those carry resolved
 * IDs after lookup). Treat these as the "raw extraction" types.
 */

import { stripHtmlTagsSafe } from "./string-utils.js";

export interface WikiLink {
  text: string;
  displayText: string;
  targetId?: string | null;
  targetTitle?: string;
}

export interface Mention {
  type: "user" | "team";
  name: string;
  id?: string;
}

export interface TaskAssignee {
  type: "user" | "team";
  name: string;
  id?: string;
}

export interface Task {
  text: string;
  completed: boolean;
  assignee: TaskAssignee | null;
}

export interface HyperlinkData {
  url: string;
  displayText: string;
}

export interface ParsedDocument {
  tags: string[];
  wikiLinks: WikiLink[];
  mentions: Mention[];
  tasks: Task[];
  hyperlinks: HyperlinkData[];
}

/** Extract #hashtags, excluding occurrences inside code blocks / inline code. */
export function extractTags(text: string): string[] {
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "");

  const tagRegex = /#([a-zA-Z][a-zA-Z0-9_-]*)/g;
  const tags: string[] = [];
  let match;

  while ((match = tagRegex.exec(withoutCode)) !== null) {
    const tag = match[1];
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }

  return tags;
}

/** Extract `[[document]]` or `[[document|display text]]` wiki links. */
export function extractWikiLinks(text: string): WikiLink[] {
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const links: WikiLink[] = [];
  let match;

  while ((match = wikiLinkRegex.exec(text)) !== null) {
    const linkText = match[1].trim();
    const displayText = match[2]?.trim() || linkText;
    links.push({ text: linkText, displayText });
  }

  return links;
}

/**
 * Extract @user and @team:name mentions. Avoids email addresses (negative
 * lookbehind on alphanumeric or `.`). Team mentions take priority — a user
 * regex match that falls inside a team match range is skipped.
 */
export function extractMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  const seen = new Set<string>();
  const teamMentionRanges: Array<[number, number]> = [];

  const teamRegex =
    /(?<![a-zA-Z0-9.])@team:(?:\(([^)]+)\)|([a-zA-Z][a-zA-Z0-9._-]*))/g;
  let match;

  while ((match = teamRegex.exec(text)) !== null) {
    const name = match[1] || match[2];
    const key = `team:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ type: "team", name });
    }
    teamMentionRanges.push([match.index, match.index + match[0].length]);
  }

  const userRegex =
    /(?<![a-zA-Z0-9.])@(?:\(([^)]+)\)|([a-zA-Z][a-zA-Z0-9._-]*))/g;

  while ((match = userRegex.exec(text)) !== null) {
    const name = match[1] || match[2];
    const matchStart = match.index;

    const isWithinTeamMention = teamMentionRanges.some(
      ([start, end]) => matchStart >= start && matchStart < end,
    );
    if (isWithinTeamMention) continue;

    const key = `user:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ type: "user", name });
    }
  }

  return mentions;
}

/** Extract markdown `[text](url)` and HTML `<a href>` hyperlinks. Excludes `[[wiki]]`. */
export function extractHyperlinks(text: string): HyperlinkData[] {
  const hyperlinks: HyperlinkData[] = [];
  const seen = new Set<string>();

  const markdownLinkRegex = /(?<!\[)\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = markdownLinkRegex.exec(text)) !== null) {
    const displayText = match[1].trim();
    const url = match[2].trim();
    const key = url.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hyperlinks.push({ url, displayText });
    }
  }

  const htmlLinkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;

  while ((match = htmlLinkRegex.exec(text)) !== null) {
    const url = match[1].trim();
    const displayText = match[2].trim();
    const key = url.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hyperlinks.push({ url, displayText });
    }
  }

  return hyperlinks;
}

/** Extract tasks: `[ ]` / `[x]` checkboxes. Handles markdown and TipTap HTML output. */
export function extractTasks(text: string): Task[] {
  const tasks: Task[] = [];
  const seen = new Set<string>();

  const markdownTaskRegex = /(?:^|\n)\s*(?:-\s*)?\[([ xX])\]\s*(.+?)(?=\n|$)/g;
  let match;

  while ((match = markdownTaskRegex.exec(text)) !== null) {
    const checkMark = match[1];
    const taskText = stripHtmlTagsSafe(match[2].trim());
    const completed = checkMark.toLowerCase() === "x";
    const assignee = extractTaskAssignee(taskText);

    const key = taskText.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tasks.push({ text: taskText, completed, assignee });
    }
  }

  const htmlTaskRegex = /\[([ xX])\]\s*([^<\n]+)/g;

  while ((match = htmlTaskRegex.exec(text)) !== null) {
    const checkMark = match[1];
    const taskText = stripHtmlTagsSafe(match[2].trim());
    const completed = checkMark.toLowerCase() === "x";
    const assignee = extractTaskAssignee(taskText);

    const key = taskText.toLowerCase();
    if (!seen.has(key) && taskText.length > 0) {
      seen.add(key);
      tasks.push({ text: taskText, completed, assignee });
    }
  }

  return tasks;
}

function extractTaskAssignee(text: string): TaskAssignee | null {
  const teamRegex =
    /(?<![a-zA-Z0-9.])@team:(?:\(([^)]+)\)|([a-zA-Z][a-zA-Z0-9._-]*))/;
  const teamMatch = text.match(teamRegex);
  if (teamMatch) {
    const name = teamMatch[1] || teamMatch[2];
    return { type: "team", name };
  }

  const userRegex =
    /(?<![a-zA-Z0-9.])@(?:\(([^)]+)\)|([a-zA-Z][a-zA-Z0-9._-]*))/;
  const userMatch = text.match(userRegex);
  if (userMatch) {
    const name = userMatch[1] || userMatch[2];
    return { type: "user", name };
  }

  return null;
}

/** Parse a markdown document and extract all metadata in one pass. */
export function parseMarkdownDocument(content: string): ParsedDocument {
  return {
    tags: extractTags(content),
    wikiLinks: extractWikiLinks(content),
    mentions: extractMentions(content),
    tasks: extractTasks(content),
    hyperlinks: extractHyperlinks(content),
  };
}

/** Render a wiki link as HTML. Resolved (with `targetId`) or broken. */
export function renderWikiLink(
  link: WikiLink & { targetId: string | null },
): string {
  if (link.targetId) {
    return `<span class="wiki-link" data-wiki-link="${link.targetId}">${link.displayText}</span>`;
  }
  return `<span class="wiki-link wiki-link-broken" data-wiki-link-broken="true">${link.displayText}</span>`;
}

/** Render a resolved mention (carries `id`) as HTML. */
export function renderMention(mention: Mention & { id: string }): string {
  return `<span class="mention mention-${mention.type}" data-mention-type="${mention.type}" data-mention-id="${mention.id}">@${mention.name}</span>`;
}

/** Render a tag as HTML. */
export function renderTag(tag: string): string {
  return `<span class="tag" data-tag="${tag}">#${tag}</span>`;
}
