export interface AgentAction {
  sessionId: string
  agentId: string
  tool: string
  params: unknown
  result: unknown
  timestamp: number
}

export interface Rule {
  id: string
  trigger: { type: 'file' | 'tool' | 'agent'; pattern: string }
  action: { type: 'inject' | 'approve' | 'log'; payload: unknown }
}

export interface Conflict {
  id: string
  sessionId: string
  file: string
  agents: string[]
  changes: Change[]
  status: 'pending' | 'resolved' | 'ignored'
}

export interface Change {
  agentId: string
  before: string
  after: string
  range: { start: number; end: number }
}

export * from './events.js'
export * from './connector.js'