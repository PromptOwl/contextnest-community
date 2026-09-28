/**
 * Central Entity Registry
 *
 * File-based multi-entity registry for tracking all automation-created
 * entities (nests, documents, tags) across test runs.
 *
 * Persisted to disk so the orphan sweeper can clean up after crashes.
 * Single source of truth for test entity tracking.
 *
 * Data stored at: tests/src/cookies_storage/entity_registry.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REGISTRY_FILE_PATH = path.join(__dirname, '..', 'cookies_storage', 'entity_registry.json');

export const ENTITY_TYPES = ['nests', 'documents'];

/**
 * Generate a short, unique run ID
 * Format: <base36Timestamp>_<shortRandom> (e.g., "m1abc_x4k9")
 * @returns {string}
 */
function generateRunId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${timestamp}_${random}`;
}

/**
 * Default registry structure
 */
function getDefaultRegistry() {
  const entities = {};
  for (const type of ENTITY_TYPES) {
    entities[type] = [];
  }
  return {
    runId: null,
    startedAt: null,
    entities,
  };
}

/**
 * Load registry from disk
 * @returns {Object} The registry object
 */
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE_PATH)) {
      const data = fs.readFileSync(REGISTRY_FILE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn(`[EntityRegistry] Failed to load registry: ${error.message}`);
  }
  return getDefaultRegistry();
}

/**
 * Save registry to disk
 * @param {Object} registry - The registry object to save
 */
function saveRegistry(registry) {
  try {
    const dir = path.dirname(REGISTRY_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_FILE_PATH, JSON.stringify(registry, null, 2));
  } catch (error) {
    console.error(`[EntityRegistry] Failed to save registry: ${error.message}`);
  }
}

/**
 * Initialize a new test run.
 * Reads the existing registry first and carries forward any undeleted entities
 * as stale entries (from a previous interrupted run). This ensures that even if
 * the previous run was killed mid-flight, its entity records survive for cleanup.
 * @returns {string} The generated runId
 */
export function initializeRun() {
  const runId = generateRunId();

  // Read existing registry before overwriting
  const previous = loadRegistry();
  const staleEntities = [];

  // Collect undeleted entities from the previous run and mark them stale
  if (previous.runId) {
    for (const type of ENTITY_TYPES) {
      const pending = (previous.entities[type] || []).filter((e) => !e.deleted);
      for (const entity of pending) {
        staleEntities.push({ ...entity, stale: true, originalRunId: previous.runId, entityType: type });
      }
    }
    if (staleEntities.length > 0) {
      console.log(
        `[EntityRegistry] Carrying forward ${staleEntities.length} stale entities from previous run ${previous.runId}`
      );
    }
  }

  // Build new registry
  const registry = getDefaultRegistry();
  registry.runId = runId;
  registry.startedAt = new Date().toISOString();
  registry.staleEntities = staleEntities;

  saveRegistry(registry);
  console.log(`[EntityRegistry] Initialized run: ${runId}`);
  return runId;
}

/**
 * Get stale entities carried forward from a previous interrupted run.
 * @returns {Array} Array of stale entity objects with { id, name, entityType, originalRunId, ... }
 */
export function getStaleEntities() {
  const registry = loadRegistry();
  return registry.staleEntities || [];
}

/**
 * Clear all stale entities from the registry (after successful cleanup).
 */
export function clearStaleEntities() {
  const registry = loadRegistry();
  registry.staleEntities = [];
  saveRegistry(registry);
  console.log(`[EntityRegistry] Stale entities cleared`);
}

/**
 * Get the current run ID
 * @returns {string|null}
 */
export function getRunId() {
  const registry = loadRegistry();
  return registry.runId;
}

/**
 * Register a created entity for cleanup tracking
 * @param {string} type - Entity type: nests|documents
 * @param {Object} entity - Entity info
 * @param {string} entity.id - Entity ID
 * @param {string} entity.name - Entity name
 * @param {Object} [entity.metadata] - Optional extra metadata (e.g. { nestId } for documents)
 */
export function registerEntity(type, { id, name, metadata }) {
  if (!ENTITY_TYPES.includes(type)) {
    console.warn(`[EntityRegistry] Unknown entity type: ${type}`);
    return;
  }

  const registry = loadRegistry();

  // Avoid duplicate registration
  const existing = registry.entities[type].find((e) => e.id === id);
  if (existing) {
    console.log(`[EntityRegistry] Entity already registered: ${type}/${id}`);
    return;
  }

  registry.entities[type].push({
    id,
    name,
    createdAt: new Date().toISOString(),
    deleted: false,
    ...(metadata ? { metadata } : {}),
  });

  saveRegistry(registry);
  console.log(`[EntityRegistry] Registered ${type}: ${name} (${id})`);
}

/**
 * Get all entities of a given type
 * @param {string} type - Entity type
 * @returns {Array} Array of entity objects
 */
export function getEntities(type) {
  const registry = loadRegistry();
  return registry.entities[type] || [];
}

/**
 * Get all entities across all types
 * @returns {Object} Map of type -> entity array
 */
export function getAllEntities() {
  const registry = loadRegistry();
  return registry.entities;
}

/**
 * Get only entities that haven't been marked as deleted
 * @param {string} [type] - Optional type filter. If omitted, returns all types.
 * @returns {Object|Array} Pending entities
 */
export function getPendingEntities(type) {
  const registry = loadRegistry();
  if (type) {
    return (registry.entities[type] || []).filter((e) => !e.deleted);
  }
  const result = {};
  for (const t of ENTITY_TYPES) {
    result[t] = (registry.entities[t] || []).filter((e) => !e.deleted);
  }
  return result;
}

/**
 * Mark an entity as deleted (cleaned up)
 * @param {string} type - Entity type
 * @param {string} id - Entity ID
 */
export function markDeleted(type, id) {
  const registry = loadRegistry();
  const entity = (registry.entities[type] || []).find((e) => e.id === id);
  if (entity) {
    entity.deleted = true;
    entity.deletedAt = new Date().toISOString();
    saveRegistry(registry);
    console.log(`[EntityRegistry] Marked deleted: ${type}/${id}`);
  }
}

/**
 * Clear the entire registry
 */
export function clearAll() {
  const registry = getDefaultRegistry();
  saveRegistry(registry);
  console.log(`[EntityRegistry] Registry cleared`);
}
