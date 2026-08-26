import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryConnectorRegistry as ConnectorRegistry } from '../registry.js'
import type { Connector } from '../../types/index.js'

describe('ConnectorRegistry', () => {
  let registry: ConnectorRegistry
  let mockConnector: Connector

  beforeEach(() => {
    registry = new ConnectorRegistry()
    mockConnector = {
      id: 'test-connector',
      name: 'Test',
      version: '1.0.0',
      capabilities: { tools: [], resources: [] },
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      sendMCPEvent: vi.fn().mockResolvedValue(undefined)
    }
  })

  it('registers and retrieves connectors', () => {
    registry.register(mockConnector)
    expect(registry.get('test-connector')).toBe(mockConnector)
    expect(registry.getAll()).toHaveLength(1)
  })

  it('unregisters connectors', () => {
    registry.register(mockConnector)
    registry.unregister('test-connector')
    expect(registry.get('test-connector')).toBeUndefined()
    expect(registry.getAll()).toHaveLength(0)
  })

  it('throws on duplicate registration', () => {
    registry.register(mockConnector)
    expect(() => registry.register(mockConnector)).toThrow('already registered')
  })
})
