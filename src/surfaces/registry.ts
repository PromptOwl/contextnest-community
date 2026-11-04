/**
 * Connector registry: one SurfaceConnector per surface. Adapters (S2a Slack,
 * S4 Teams, S5 email) register at startup; tests register the in-memory fake.
 * An unregistered surface has no connector, so its members are unknown and
 * every guard on it fails closed.
 */
import type { Surface, SurfaceConnector } from "./contract.js";

const connectors = new Map<Surface, SurfaceConnector>();

export function registerConnector(connector: SurfaceConnector): void {
  connectors.set(connector.surface, connector);
}

export function getConnector(surface: Surface): SurfaceConnector | null {
  return connectors.get(surface) ?? null;
}

export function clearConnectors(): void {
  connectors.clear();
}
