import type { NormalizedAgentEvent } from '../types/index.js'
import type { ConnectorRegistry } from './registry.js'

export interface IngestionPipelineOptions {
  apiBaseUrl: string
  registry: ConnectorRegistry
}

export class IngestionPipeline {
  private apiBaseUrl: string
  private registry: IngestionPipelineOptions['registry']

  constructor({ apiBaseUrl, registry }: IngestionPipelineOptions) {
    this.apiBaseUrl = apiBaseUrl
    this.registry = registry
  }

  start(): void {
    for (const connector of this.registry.getAll()) {
      connector.onEvent((event) => this.handleEvent(event))
    }
  }

  async handleEvent(event: NormalizedAgentEvent): Promise<void> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: event.sessionId,
          agentId: event.agentId,
          tool: event.tool,
          params: event.params,
          result: event.result,
          connectorId: event.connectorId,
          connectorVersion: event.connectorVersion,
          mcpEventId: event.mcpEventId
        })
      })

      if (!res.ok) {
        console.warn(`IngestionPipeline: API returned ${res.status} for event ${event.mcpEventId}`)
      }
    } catch (err) {
      console.warn(`IngestionPipeline: failed to forward event ${event.mcpEventId}:`, err)
    }
  }
}
