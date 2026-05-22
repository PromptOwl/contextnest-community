/**
 * stewards.yaml Parser — reads stewardship config from nest vault root.
 *
 * Ported from PromptOwl's deserializeStewards in lib/context-nest/serializers.ts.
 * Parses the portable stewards.yaml format and returns a StewardsConfig object.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import type { StewardsConfig, StewardEntry } from "./types.js";

/**
 * Parse a simple YAML-like stewards config.
 * Uses a lightweight parser (no external YAML dependency).
 * Supports the canonical stewards.yaml format from the ContextNest spec.
 */
export function parseStewardsYaml(content: string): StewardsConfig {
  const result: StewardsConfig = { version: 1 };

  const lines = content.split("\n");
  let currentSection: string | null = null;
  let currentTarget: string | null = null;
  let currentEntries: StewardEntry[] = [];

  const flushTarget = () => {
    if (!currentSection || currentEntries.length === 0) return;

    if (currentSection === "nest") {
      result.nest = [...(result.nest || []), ...currentEntries];
    } else if (currentSection === "tags" && currentTarget) {
      result.tags = result.tags || {};
      result.tags[currentTarget] = currentEntries;
    } else if (currentSection === "documents" && currentTarget) {
      result.documents = result.documents || {};
      result.documents[currentTarget] = currentEntries;
    }
    currentEntries = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    // Top-level sections (no indent)
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.endsWith(":")) {
      flushTarget();
      currentTarget = null;
      const key = line.slice(0, -1).trim();

      if (key === "version") continue;
      if (key === "nest" || key === "data_room") {
        currentSection = "nest";
      } else if (key === "tags") {
        currentSection = "tags";
      } else if (key === "documents") {
        currentSection = "documents";
      } else if (key === "folders") {
        // Legacy 'folders:' section ignored — folder scope removed.
        currentSection = null;
      }
      continue;
    }

    // Sub-target (2-space or 1-tab indent, ends with colon)
    const subMatch = line.match(/^(?:  |\t)([^\s].*):$/);
    if (subMatch && currentSection && currentSection !== "nest") {
      flushTarget();
      currentTarget = subMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }

    // List entry (starts with -)
    const entryMatch = line.match(/^\s+-\s+(.*)/);
    if (entryMatch) {
      const entryStr = entryMatch[1].trim();
      const entry = parseEntry(entryStr);
      if (entry) currentEntries.push(entry);
    }
  }

  flushTarget();
  return result;
}

function parseEntry(str: string): StewardEntry | null {
  // Could be inline object: { email: foo@bar.com, role: reviewer }
  // Or just: email: foo@bar.com
  // Or key: value pairs on one line.
  // Legacy can_approve/can_reject keys are accepted but ignored — role
  // is now the sole signal (reviewer = approve+reject).

  const emailMatch = str.match(/email:\s*["']?([^\s,"'{}]+)["']?/);
  if (!emailMatch) return null;

  const entry: StewardEntry = { email: emailMatch[1] };

  const roleMatch = str.match(/role:\s*["']?(\w+)["']?/);
  if (roleMatch) entry.role = roleMatch[1] as any;

  return entry;
}

/**
 * Load stewards.yaml from a nest's vault directory.
 * Returns null if the file doesn't exist.
 */
export function loadStewardsConfig(nestId: string): StewardsConfig | null {
  const dataRoot = config.DATA_ROOT;
  const nestPath = join(dataRoot, "nests", nestId);

  // Check multiple possible locations
  const candidates = [
    join(nestPath, "stewards.yaml"),
    join(nestPath, "stewards.yml"),
    join(nestPath, ".context", "stewards.yaml"),
  ];

  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) {
      const content = readFileSync(candidatePath, "utf-8");
      return parseStewardsYaml(content);
    }
  }

  return null;
}

/**
 * Check if a nest has stewardship configured.
 */
export function hasStweardshipConfig(nestId: string): boolean {
  return loadStewardsConfig(nestId) !== null;
}
