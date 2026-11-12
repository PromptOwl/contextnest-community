/**
 * Fields REST Helpers
 *
 * Preconditions for the Fields suite — custom field definitions, task rules
 * (numbering, surfaces, stages, priorities), tasks with field values, a
 * viewer share, a nest-wide reviewer, an archived nest — are arranged through
 * the REST API, and what the Fields tab saved is read back the same way.
 *
 * Extends CollaboratorsApi, so the nest, document, share, steward and cleanup
 * helpers are the same ones: every nest created here is in the entity registry
 * and is deleted after the test (`deleteCreatedNests()`), and the teardown or
 * the next run's orphan sweeper catches anything left behind. Fields, tasks and
 * task rules live inside those nests and go with them.
 */

import CollaboratorsApi from './collaborators_api.js';

class FieldsApi extends CollaboratorsApi {
  // ── Custom field definitions ───────────────────────────────────────────────

  /**
   * POST /nests/:id/fields — define a field. `body` is the API shape
   * (`label`, `key`, `type`, `options`, `required`, `default_value`,
   * `applies_to`, `unit`) or a preset (`{ preset: 'estimate', unit }`).
   */
  async createField(nestId, body) {
    const data = await this.expectOk('POST', `/nests/${nestId}/fields`, body);
    return data.field;
  }

  /** GET /nests/:id/fields — the nest's field definitions, in order. */
  async fieldDefs(nestId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/fields`);
    return data?.fields ?? [];
  }

  /** One field definition by key, or null. */
  async fieldDef(nestId, key) {
    return (await this.fieldDefs(nestId)).find((f) => f.key === key) ?? null;
  }

  // ── Task rules (the Task numbering card) ───────────────────────────────────

  /** GET /nests/:id/settings — the nest's task rules. */
  async taskRules(nestId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/settings`);
    return (data?.settings ?? data)?.task_rules ?? null;
  }

  /**
   * PATCH /nests/:id/settings — change some task rules and keep the rest, the
   * way the card's Save does (it always sends the whole set).
   */
  async setTaskRules(nestId, patch) {
    const current = (await this.taskRules(nestId)) ?? {};
    return this.expectOk('PATCH', `/nests/${nestId}/settings`, { task_rules: { ...current, ...patch } });
  }

  // ── Tasks and their values ─────────────────────────────────────────────────

  /**
   * POST /nests/:id/nodes — a task, optionally with tags and field values.
   * The nest's task rules apply as they do to any new task (number, stage,
   * required defaults).
   */
  async createTaskNode(nestId, { title, tags, fields }) {
    const data = await this.expectOk('POST', `/nests/${nestId}/nodes`, {
      title,
      type: 'task',
      content: `# ${title}\n\nTask notes.\n`,
      ...(tags ? { tags } : {}),
    });
    if (fields) await this.setFieldValues(nestId, data.node.id, fields);
    return data.node;
  }

  /** PATCH /nests/:id/nodes/:nodeId — set field values on a document or task. */
  async setFieldValues(nestId, nodeId, fields) {
    return this.expectOk('PATCH', `/nests/${nestId}/nodes/${nodeId}`, { fields });
  }

  /** GET /nests/:id/nodes/:nodeId — the document or task. */
  async node(nestId, nodeId) {
    const data = await this.expectOk('GET', `/nests/${nestId}/nodes/${nodeId}`);
    return data.node;
  }

  /** The document or task with this title, or null. */
  async nodeByTitle(nestId, title) {
    return (await this.listDocuments(nestId)).find((n) => n.title === title) ?? null;
  }

  /** A task's ticket number as shown ("QA-1"), or null when it has none. */
  async ticketOf(nestId, nodeId) {
    const tag = ((await this.node(nestId, nodeId)).tags ?? []).find((t) => /^#?ticket:/i.test(t));
    return tag ? tag.replace(/^#?ticket:/i, '').toUpperCase() : null;
  }
}

export default FieldsApi;
