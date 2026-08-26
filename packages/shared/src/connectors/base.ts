import type { Connector, ConnectorCapabilities } from '../types/connector.js'
import type { NormalizedAgentEvent, MCPEvent } from '../types/events.js'

export abstract class BaseConnector implements Connector {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly version: string
  abstract readonly capabilities: ConnectorCapabilities

  protected eventHandlers: ((event: NormalizedAgentEvent) => void)[] = []

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.eventHandlers.push(handler)
  }

  protected emitEvent(event: NormalizedAgentEvent): void {
    this.eventHandlers.forEach(h => h(event))
  }

  async sendMCPEvent(event: MCPEvent): Promise<void> {
    throw new Error(`sendMCPEvent not implemented for connector ${this.id} (${event.type} ${event.id})`)
  }
}
