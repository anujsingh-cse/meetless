import type { Connector, ConnectorRegistry } from '../types/connector.js'
export type { ConnectorRegistry } from '../types/connector.js'

export class InMemoryConnectorRegistry implements ConnectorRegistry {
  private connectors = new Map<string, Connector>()

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector ${connector.id} already registered`)
    }
    this.connectors.set(connector.id, connector)
  }

  unregister(connectorId: string): void {
    this.connectors.delete(connectorId)
  }

  get(connectorId: string): Connector | undefined {
    return this.connectors.get(connectorId)
  }

  getAll(): Connector[] {
    return Array.from(this.connectors.values())
  }
}

export const connectorRegistry = new InMemoryConnectorRegistry()
