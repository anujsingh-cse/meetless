import type { NormalizedAgentEvent, MCPEvent } from './events.js'

export interface ConnectorCapabilities {
  tools: string[]
  resources: string[]
}

export interface Connector {
  id: string
  name: string
  version: string
  capabilities: ConnectorCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  onEvent(handler: (event: NormalizedAgentEvent) => void): void
  sendMCPEvent(event: MCPEvent): Promise<void>
}

export interface ConnectorRegistry {
  register(connector: Connector): void
  unregister(connectorId: string): void
  get(connectorId: string): Connector | undefined
  getAll(): Connector[]
}
