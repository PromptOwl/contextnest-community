/**
 * Access Service — server-level access control via access.yaml.
 *
 * Loaded once on startup from DATA_ROOT/access.yaml.
 * Controls: who can register, group memberships, default permissions, super admins.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import type { AccessConfig } from "./types.js";

let accessConfig: AccessConfig | null = null;

/**
 * Load access.yaml from DATA_ROOT. Returns null if not present.
 */
export function loadAccessConfig(): AccessConfig | null {
  const candidates = [
    join(config.DATA_ROOT, "access.yaml"),
    join(config.DATA_ROOT, "access.yml"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      accessConfig = parseAccessYaml(content);
      return accessConfig;
    }
  }

  accessConfig = null;
  return null;
}

export function getAccessConfig(): AccessConfig | null {
  return accessConfig;
}

/**
 * "*.acme.com" should match any email at acme.com (incl. subdomains like
 * user@team.acme.com). The previous impl did `endsWith(".acme.com")` which
 * never matched because emails are "user@domain", not "user.domain" — bug.
 */
function matchEmailPattern(email: string, pattern: string): boolean {
  if (pattern === email) return true;
  if (!pattern.startsWith("*.")) return false;
  const domain = pattern.slice(2); // "acme.com"
  const at = email.indexOf("@");
  if (at < 0) return false;
  const emailDomain = email.slice(at + 1); // "team.acme.com" / "acme.com"
  return emailDomain === domain || emailDomain.endsWith("." + domain);
}

/**
 * Check if an email is allowed to register.
 * If access.yaml is not present or mode is not "restricted", everyone is allowed.
 */
export function isEmailAllowed(email: string): boolean {
  if (!accessConfig || accessConfig.mode !== "restricted") return true;
  if (!accessConfig.allowed_users?.length) return true;

  const lower = email.toLowerCase();
  return accessConfig.allowed_users.some((pattern) =>
    matchEmailPattern(lower, pattern.toLowerCase()),
  );
}

/**
 * Get the groups a user belongs to based on their email.
 */
export function getGroupsForUser(email: string): string[] {
  if (!accessConfig?.groups) return [];
  const lower = email.toLowerCase();

  return Object.entries(accessConfig.groups)
    .filter(([, group]) =>
      group.members.some((m) => matchEmailPattern(lower, m.toLowerCase())),
    )
    .map(([name]) => name);
}

/**
 * Get the highest default permission for a user based on group membership.
 */
export function getDefaultPermission(
  email: string,
): "read" | "write" | "admin" | null {
  if (!accessConfig?.groups) return null;

  const groups = getGroupsForUser(email);
  if (groups.length === 0) return null;

  const levels = { read: 1, write: 2, admin: 3 };
  let best: "read" | "write" | "admin" | null = null;

  for (const groupName of groups) {
    const group = accessConfig.groups[groupName];
    if (!group) continue;
    const perm = group.default_permission;
    if (!best || levels[perm] > levels[best]) {
      best = perm;
    }
  }

  return best;
}

/**
 * Check if a user is a super admin.
 */
export function isSuperAdmin(email: string): boolean {
  if (!accessConfig?.super_admins) return false;
  return accessConfig.super_admins
    .map((e) => e.toLowerCase())
    .includes(email.toLowerCase());
}

// ─── Simple YAML parser for access.yaml ─────────────────────────────────

function parseAccessYaml(content: string): AccessConfig {
  const result: AccessConfig = {};
  const lines = content.split("\n");
  let currentSection: string | null = null;
  let currentGroup: string | null = null;
  let inMembers = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    // Top-level key
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const match = line.match(/^(\w+):\s*(.*)?$/);
      if (!match) continue;
      const key = match[1];
      const value = match[2]?.trim();

      if (key === "mode") {
        result.mode = value as any;
        currentSection = null;
      } else if (key === "allowed_users") {
        currentSection = "allowed_users";
        result.allowed_users = [];
      } else if (key === "groups") {
        currentSection = "groups";
        result.groups = {};
      } else if (key === "super_admins") {
        currentSection = "super_admins";
        result.super_admins = [];
      }
      currentGroup = null;
      inMembers = false;
      continue;
    }

    // List entry
    const listMatch = line.match(/^\s+-\s+["']?([^"'\n]+?)["']?\s*$/);

    if (currentSection === "allowed_users" && listMatch) {
      result.allowed_users!.push(listMatch[1].trim());
      continue;
    }

    if (currentSection === "super_admins" && listMatch) {
      result.super_admins!.push(listMatch[1].trim());
      continue;
    }

    if (currentSection === "groups") {
      // Group name (2-space indent)
      const groupMatch = line.match(/^  (\w+):$/);
      if (groupMatch) {
        currentGroup = groupMatch[1];
        result.groups![currentGroup] = { members: [], default_permission: "read" };
        inMembers = false;
        continue;
      }

      // Group properties (4-space indent)
      if (currentGroup) {
        const propMatch = line.match(/^\s{4}(\w+):\s*(.*)?$/);
        if (propMatch) {
          const prop = propMatch[1];
          const val = propMatch[2]?.trim();
          if (prop === "default_permission" && val) {
            result.groups![currentGroup].default_permission = val as any;
          }
          if (prop === "members") {
            inMembers = true;
          }
          continue;
        }

        // Member list entries (6-space indent)
        if (inMembers && listMatch) {
          result.groups![currentGroup].members.push(listMatch[1].trim());
        }
      }
    }
  }

  return result;
}
