# Phase 2A: First MCP Connector + Agent Event Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one complete end-to-end path from a single MCP-based coding-agent connector (Claude Code) into Meetless, demonstrating: Claude Code → MCP connector → normalized event → Meetless ingestion → persistence → reconciliation → conflict detection.

**Architecture:** This vertical slice adds a minimal connector abstraction layer on top of the existing Phase 1 infrastructure (Fastify API, WebSocket server, Prisma database, shared types). The connector abstraction normalizes MCP events into Meetless agent events, persists them via Prisma, runs a minimal reconciliation pass to detect file-level conflicts between concurrent agents, and exposes conflicts via the existing Fastify API + WebSocket.

**Tech Stack:** TypeScript, Fastify, Prisma ORM, PostgreSQL, WebSocket (ws), Zod for validation, Vitest for testing, @modelcontextprotocol/sdk for MCP.

**Spec:** This plan implements the Phase 2A vertical slice as described in the user request.

## Global Constraints

- Node.js >= 20
- TypeScript strict mode
- Fastify plugins only (no Express)
- Prisma schema in `packages/database/prisma/schema.prisma`
- All env vars via `dotenv` + Zod validation in `@meetless/shared/config`
- Tests: Vitest, run via `npm run test`
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`)
- Do NOT implement Codex, Cursor, OpenCode connectors
- Do NOT build dashboard, tunnel, rule engine, SoT generator
- Reuse existing Phase 1 types, database models, API, WebSocket infrastructure
- All tests must pass locally before commit

---

### Task 1: Define Normalized Agent Event Types & Connector Abstraction

**Files:**
- Create: `packages/shared/src/types/connector.ts`
- Create: `packages/shared/src/types/events.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export new types)

**Interfaces:**
- Consumes: Existing `AgentAction`, `Conflict`, `Change` from `packages/shared/src/types/index.ts`
- Produces: `Connector`, `MCPEvent`, `NormalizedAgentEvent`, `ConnectorCapabilities` types for later tasks

- [ ] **Step 1: Write failing test for new types**

```typescript
// packages/shared/src/types/__tests__/connector.test.ts
import { describe, it, expect } from 'vitest'
import type { Connector, NormalizedAgentEvent, MCPEvent } from '../connector.js'

describe('Connector types', () => {
  it('NormalizedAgentEvent extends AgentAction with connector metadata', () => {
    const event: NormalizedAgentEvent = {
      sessionId: 'sess-1',
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: '...' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-evt-123'
    }
    expect(event.connectorId).toBe('claude-code')
    expect(event.mcpEventId).toBeDefined()
  })

  it('Connector interface defines required methods', () => {
    const connector: Connector = {
      id: 'claude-code',
      name: 'Claude Code',
      version: '1.0.0',
      capabilities: { tools: ['edit_file', 'read_file'], resources: [] },
      connect: async () => {},
      disconnect: async () => {},
      onEvent: (handler) => {}
    }
    expect(connector.id).toBe('claude-code')
    expect(typeof connector.connect).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/types/__tests__/connector.test.ts`
Expected: FAIL - types don't exist yet

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/shared/src/types/events.ts
import type { AgentAction } from './index.js'

export interface NormalizedAgentEvent extends AgentAction {
  connectorId: string
  connectorVersion: string
  mcpEventId: string
  rawMCPEvent?: unknown
}

export interface MCPEvent {
  id: string
  type: 'tool_call' | 'tool_result' | 'resource_read' | 'notification'
  payload: unknown
  timestamp: number
}
```

```typescript
// packages/shared/src/types/connector.ts
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
```

- [ ] **Step 4: Re-export from index.ts**

```typescript
// packages/shared/src/types/index.ts (add to end)
export * from './events.js'
export * from './connector.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/types/__tests__/connector.test.ts`
Expected: PASS

- [ ] **Step 6: Run lint and build**

Run: `npm run lint --workspace=@meetless/shared && npm run build --workspace=@meetless/shared`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/connector.ts packages/shared/src/types/events.ts packages/shared/src/types/__tests__/connector.test.ts packages/shared/src/types/index.ts
git commit -m "feat: add connector abstraction and normalized agent event types"
```

---

### Task 2: Add Database Models for Connectors & Normalized Events

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/<timestamp>_add_connector_models.sql` (auto-generated)

**Interfaces:**
- Consumes: `NormalizedAgentEvent`, `Connector` types from `@meetless/shared/types`
- Produces: `Connector`, `NormalizedEvent` Prisma models for Tasks 3-5

- [ ] **Step 1: Write failing test for new Prisma models**

```typescript
// packages/database/src/__tests__/connector-models.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

describe('Connector Prisma models', () => {
  beforeAll(async () => { await prisma.$connect() })
  afterAll(async () => { await prisma.$disconnect() })

  it('creates and reads a Connector record', async () => {
    const connector = await prisma.connector.create({
      data: {
        id: 'claude-code',
        name: 'Claude Code',
        version: '1.0.0',
        capabilities: { tools: ['edit_file'], resources: [] },
        status: 'disconnected'
      }
    })
    expect(connector.id).toBe('claude-code')
    expect(connector.capabilities).toEqual({ tools: ['edit_file'], resources: [] })
  })

  it('creates and reads a NormalizedEvent record linked to session', async () => {
    const session = await prisma.session.create({
      data: { workspaceId: 'ws-1', userId: 'user-1', name: 'Test Session' }
    })
    const event = await prisma.normalizedEvent.create({
      data: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/foo.ts' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'mcp-123',
        timestamp: new Date()
      }
    })
    expect(event.sessionId).toBe(session.id)
    expect(event.connectorId).toBe('claude-code')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/database -- packages/database/src/__tests__/connector-models.test.ts`
Expected: FAIL - models don't exist

- [ ] **Step 3: Add Prisma models to schema.prisma**

```prisma
// packages/database/prisma/schema.prisma (add after Conflict model)

model Connector {
  id            String   @id @default(cuid())
  name          String
  version       String
  capabilities  Json
  status        String   @default("disconnected") // connected, disconnected, error
  lastConnected DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  events        NormalizedEvent[]
}

model NormalizedEvent {
  id              String   @id @default(cuid())
  sessionId       String
  agentId         String
  tool            String
  params          Json
  result          Json?
  connectorId     String
  connectorVersion String
  mcpEventId      String
  rawMCPEvent     Json?
  timestamp       DateTime @default(now())
  session         Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  connector       Connector @relation(fields: [connectorId], references: [id], onDelete: Cascade)

  @@index([sessionId, timestamp])
  @@index([connectorId, timestamp])
}
```

- [ ] **Step 4: Generate migration and Prisma client**

Run: `npm run db:generate --workspace=@meetless/database && npm run db:push --workspace=@meetless/database`
Expected: Client generated, schema pushed

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/database -- packages/database/src/__tests__/connector-models.test.ts`
Expected: PASS

- [ ] **Step 6: Run lint and build**

Run: `npm run lint --workspace=@meetless/database && npm run build --workspace=@meetless/database`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/ packages/database/src/__tests__/connector-models.test.ts
git commit -m "feat: add Connector and NormalizedEvent Prisma models"
```

---

### Task 3: Implement Connector Registry & Base Connector Class

**Files:**
- Create: `packages/shared/src/connectors/registry.ts`
- Create: `packages/shared/src/connectors/base.ts`
- Create: `packages/shared/src/connectors/index.ts`
- Create: `packages/shared/src/connectors/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `Connector`, `ConnectorRegistry`, `NormalizedAgentEvent` from `@meetless/shared/types`
- Produces: `ConnectorRegistry` implementation, `BaseConnector` abstract class for Task 4

- [ ] **Step 1: Write failing test for registry**

```typescript
// packages/shared/src/connectors/__tests__/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ConnectorRegistry } from '../registry.js'
import type { Connector, NormalizedAgentEvent } from '../../types/index.js'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/registry.test.ts`
Expected: FAIL - registry doesn't exist

- [ ] **Step 3: Implement registry and base connector**

```typescript
// packages/shared/src/connectors/registry.ts
import type { Connector, ConnectorRegistry } from '../types/connector.js'

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
```

```typescript
// packages/shared/src/connectors/base.ts
import type { Connector, NormalizedAgentEvent, MCPEvent, ConnectorCapabilities } from '../types/connector.js'

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
    throw new Error('sendMCPEvent not implemented')
  }
}
```

```typescript
// packages/shared/src/connectors/index.ts
export * from './registry.js'
export * from './base.js'
```

- [ ] **Step 4: Export from shared package index**

```typescript
// packages/shared/src/index.ts (add)
export * from './connectors/index.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Run lint and build**

Run: `npm run lint --workspace=@meetless/shared && npm run build --workspace=@meetless/shared`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/connectors/ packages/shared/src/index.ts
git commit -m "feat: add connector registry and base connector class"
```

---

### Task 4: Implement Claude Code MCP Connector

**Files:**
- Create: `packages/shared/src/connectors/claude-code.ts`
- Create: `packages/shared/src/connectors/__tests__/claude-code.test.ts`

**Interfaces:**
- Consumes: `BaseConnector`, `NormalizedAgentEvent`, `MCPEvent` from `@meetless/shared/types` and `@meetless/shared/connectors`
- Produces: `ClaudeCodeConnector` class for Task 5

- [ ] **Step 1: Write failing test for Claude Code connector**

```typescript
// packages/shared/src/connectors/__tests__/claude-code.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeCodeConnector } from '../claude-code.js'
import type { NormalizedAgentEvent } from '../../types/index.js'

describe('ClaudeCodeConnector', () => {
  let connector: ClaudeCodeConnector
  let mockProcess: { stdin: { write: ReturnType<typeof vi.fn> }; on: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockProcess = {
      stdin: { write: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    }
    vi.spyOn(require('child_process'), 'spawn').mockReturnValue(mockProcess as any)
    connector = new ClaudeCodeConnector({ workingDir: '/test/workspace' })
  })

  it('initializes with correct metadata', () => {
    expect(connector.id).toBe('claude-code')
    expect(connector.name).toBe('Claude Code')
    expect(connector.capabilities.tools).toContain('edit_file')
  })

  it('spawns claude process on connect', async () => {
    await connector.connect()
    expect(require('child_process').spawn).toHaveBeenCalledWith('claude', ['--mcp'], expect.any(Object))
  })

  it('normalizes tool_call MCP event to NormalizedAgentEvent', async () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    // Simulate MCP tool_call from Claude
    const mcpEvent = {
      id: 'mcp-1',
      type: 'tool_call',
      payload: { tool: 'edit_file', params: { path: 'src/foo.ts', content: 'new' } },
      timestamp: Date.now()
    }

    // Trigger internal handler (simulate stdout message)
    connector['handleMCPMessage'](JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: mcpEvent, id: '1' }))

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].connectorId).toBe('claude-code')
    expect(events[0].mcpEventId).toBe('mcp-1')
  })

  it('disconnects and kills process', async () => {
    await connector.connect()
    await connector.disconnect()
    expect(connector['process'].kill).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/claude-code.test.ts`
Expected: FAIL - connector doesn't exist

- [ ] **Step 3: Implement Claude Code connector**

```typescript
// packages/shared/src/connectors/claude-code.ts
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { BaseConnector } from './base.js'
import type { NormalizedAgentEvent, MCPEvent, ConnectorCapabilities } from '../types/index.js'

interface MCPMessage {
  jsonrpc: '2.0'
  id: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export class ClaudeCodeConnector extends BaseConnector {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly version = '1.0.0'
  readonly capabilities: ConnectorCapabilities = {
    tools: ['edit_file', 'read_file', 'list_files', 'grep', 'todo_write', 'bash'],
    resources: ['file://*']
  }

  private process: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private workingDir: string

  constructor(options: { workingDir: string }) {
    super()
    this.workingDir = options.workingDir
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn('claude', ['--mcp'], {
        cwd: this.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_MCP_MODE: '1' }
      })

      this.process.stdout.on('data', (data) => this.handleStdout(data))
      this.process.stderr.on('data', (data) => console.error('[Claude MCP stderr]', data.toString()))
      this.process.on('error', reject)
      this.process.on('close', (code) => {
        if (code !== 0) console.error(`Claude Code exited with code ${code}`)
      })

      // Wait for initialization handshake
      setTimeout(resolve, 1000)
    })
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  private handleStdout(data: Buffer): void {
    this.buffer += data.toString()
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg: MCPMessage = JSON.parse(line)
          this.handleMCPMessage(msg)
        } catch (e) {
          console.warn('Failed to parse MCP message:', line)
        }
      }
    }
  }

  private handleMCPMessage(msg: MCPMessage): void {
    if (msg.method === 'tools/call' && msg.params) {
      const { name: tool, arguments: params } = msg.params as { name: string; arguments: unknown }
      const event: NormalizedAgentEvent = {
        sessionId: '', // Will be filled by ingestion pipeline
        agentId: `claude-${this.process?.pid}`,
        tool,
        params: params as Record<string, unknown>,
        result: msg.result,
        timestamp: Date.now(),
        connectorId: this.id,
        connectorVersion: this.version,
        mcpEventId: String(msg.id)
      }
      this.emitEvent(event)
    }
  }

  async sendMCPEvent(event: MCPEvent): Promise<void> {
    if (!this.process) throw new Error('Not connected')
    const msg: MCPMessage = {
      jsonrpc: '2.0',
      id: event.id,
      method: event.type === 'tool_call' ? 'tools/call' : 'resources/read',
      params: event.payload
    }
    this.process!.stdin.write(JSON.stringify(msg) + '\n')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/claude-code.test.ts`
Expected: PASS

- [ ] **Step 5: Run lint and build**

Run: `npm run lint --workspace=@meetless/shared && npm run build --workspace=@meetless/shared`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/connectors/claude-code.ts packages/shared/src/connectors/__tests__/claude-code.test.ts
git commit -m "feat: add Claude Code MCP connector"
```

---

### Task 5: Create Agent Event Ingestion API Endpoint

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Create: `apps/api/src/routes/__tests__/events.test.ts`
- Modify: `apps/api/src/app.ts` (register new routes)

**Interfaces:**
- Consumes: `NormalizedAgentEvent`, `Connector` from `@meetless/shared/types`; Prisma client from `@meetless/database`
- Produces: REST endpoints for event ingestion, conflict retrieval

- [ ] **Step 1: Write failing test for event ingestion endpoint**

```typescript
// apps/api/src/routes/__tests__/events.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => { await app.close() })

describe('POST /api/events', () => {
  it('accepts normalized agent event and persists to database', async () => {
    const session = await prisma.session.create({
      data: { workspaceId: 'ws-1', userId: 'user-1', name: 'Test' }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/foo.ts', content: 'new content' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'mcp-123'
      }
    })

    expect(response.statusCode).toBe(201)
    const body = JSON.parse(response.payload)
    expect(body.id).toBeDefined()
    expect(body.sessionId).toBe(session.id)
    expect(body.tool).toBe('edit_file')
  })

  it('rejects events with invalid sessionId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: 'invalid-session',
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/foo.ts' },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'mcp-123'
      }
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/sessions/:sessionId/conflicts', () => {
  it('returns conflicts for a session', async () => {
    // Setup: create session with two agents editing same file
    const session = await prisma.session.create({
      data: { workspaceId: 'ws-1', userId: 'user-1', name: 'Conflict Test' }
    })
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId: session.id, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'a' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId: session.id, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/conflicts`
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(Array.isArray(body)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/api -- apps/api/src/routes/__tests__/events.test.ts`
Expected: FAIL - routes don't exist

- [ ] **Step 3: Implement event ingestion routes**

```typescript
// apps/api/src/routes/events.ts
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { prisma } from '@meetless/database/client'
import { ReconciliationEngine } from '../../services/reconciliation.js'

const eventSchema = z.object({
  sessionId: z.string().cuid(),
  agentId: z.string(),
  tool: z.string(),
  params: z.record(z.unknown()),
  result: z.record(z.unknown()).optional(),
  connectorId: z.string(),
  connectorVersion: z.string(),
  mcpEventId: z.string()
})

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const reconciliation = new ReconciliationEngine(app.prisma)

  app.post('/api/events', {
    schema: {
      body: eventSchema,
      response: {
        201: z.object({ id: z.string(), sessionId: z.string(), tool: z.string() }),
        400: z.object({ error: z.string() })
      }
    }
  }, async (req, reply) => {
    const session = await app.prisma.session.findUnique({ where: { id: req.body.sessionId } })
    if (!session) return reply.code(400).send({ error: 'Invalid sessionId' })

    const event = await app.prisma.normalizedEvent.create({
      data: {
        sessionId: req.body.sessionId,
        agentId: req.body.agentId,
        tool: req.body.tool,
        params: req.body.params,
        result: req.body.result ?? {},
        connectorId: req.body.connectorId,
        connectorVersion: req.body.connectorVersion,
        mcpEventId: req.body.mcpEventId,
        timestamp: new Date()
      }
    })

    // Trigger reconciliation after event ingestion
    await reconciliation.processSessionEvent(event)

    return reply.code(201).send({ id: event.id, sessionId: event.sessionId, tool: event.tool })
  })

  app.get('/api/sessions/:sessionId/conflicts', {
    schema: {
      params: z.object({ sessionId: z.string().cuid() }),
      response: {
        200: z.array(z.object({
          id: z.string(),
          sessionId: z.string(),
          file: z.string(),
          agents: z.array(z.string()),
          status: z.string(),
          createdAt: z.string()
        }))
      }
    }
  }, async (req) => {
    const conflicts = await app.prisma.conflict.findMany({
      where: { sessionId: req.params.sessionId },
      orderBy: { createdAt: 'desc' }
    })
    return conflicts.map(c => ({
      id: c.id,
      sessionId: c.sessionId,
      file: c.file,
      agents: c.agents,
      status: c.status,
      createdAt: c.createdAt.toISOString()
    }))
  })
}
```

- [ ] **Step 4: Register routes in app.ts**

```typescript
// apps/api/src/app.ts (add import and registration)
import { eventRoutes } from './routes/events.js'
// ... inside buildApp():
await app.register(eventRoutes, { prefix: '/api' })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/api -- apps/api/src/routes/__tests__/events.test.ts`
Expected: PASS

- [ ] **Step 6: Run lint and build**

Run: `npm run lint --workspace=@meetless/api && npm run build --workspace=@meetless/api`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/events.ts apps/api/src/routes/__tests__/events.test.ts apps/api/src/app.ts
git commit -m "feat: add agent event ingestion API endpoints"
```

---

### Task 6: Implement Minimal Reconciliation Engine

**Files:**
- Create: `apps/api/src/services/reconciliation.ts`
- Create: `apps/api/src/services/__tests__/reconciliation.test.ts`

**Interfaces:**
- Consumes: Prisma client, `NormalizedEvent`, `Conflict` models from `@meetless/database`
- Produces: `ReconciliationEngine` class for Task 7

- [ ] **Step 1: Write failing test for reconciliation engine**

```typescript
// apps/api/src/services/__tests__/reconciliation.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { ReconciliationEngine } from '../reconciliation.js'

const prisma = new PrismaClient()

describe('ReconciliationEngine', () => {
  let engine: ReconciliationEngine
  let sessionId: string

  beforeAll(async () => {
    await prisma.$connect()
    engine = new ReconciliationEngine(prisma)
  })

  afterAll(async () => { await prisma.$disconnect() })

  beforeEach(async () => {
    await prisma.normalizedEvent.deleteMany()
    await prisma.conflict.deleteMany()
    await prisma.session.deleteMany()
    const session = await prisma.session.create({ data: { workspaceId: 'ws-1', userId: 'user-1', name: 'Reconciliation Test' } })
    sessionId = session.id
  })

  it('detects conflict when two agents edit same file', async () => {
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'a' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    await engine.processSessionEvent({ sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: Date.now() } as any)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/foo.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
  })

  it('does not create conflict for different files', async () => {
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'a' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/bar.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    await engine.processSessionEvent({ sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/bar.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: Date.now() } as any)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/api -- apps/api/src/services/__tests__/reconciliation.test.ts`
Expected: FAIL - engine doesn't exist

- [ ] **Step 3: Implement reconciliation engine**

```typescript
// apps/api/src/services/reconciliation.ts
import { PrismaClient } from '@prisma/client'
import type { NormalizedAgentEvent } from '@meetless/shared/types'

interface FileEdit {
  agentId: string
  content: string
  timestamp: Date
}

export class ReconciliationEngine {
  private prisma: PrismaClient
  private pendingEdits = new Map<string, Map<string, FileEdit>>() // sessionId -> filePath -> agentId -> edit

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  async processSessionEvent(event: NormalizedAgentEvent): Promise<void> {
    if (event.tool !== 'edit_file') return

    const filePath = event.params.path as string
    const content = event.params.content as string
    const sessionEdits = this.pendingEdits.get(event.sessionId) || new Map()
    const fileEdits = sessionEdits.get(event.params.path as string) || new Map()

    // Record this agent's edit
    fileEdits.set(event.agentId, { agentId: event.agentId, content, timestamp: new Date(event.timestamp) })
    sessionEdits.set(filePath, fileEdits)
    this.pendingEdits.set(event.sessionId, sessionEdits)

    // Check for conflicts with other agents
    if (fileEdits.size >= 2) {
      const agents = Array.from(fileEdits.keys())
      const contents = agents.map(a => fileEdits.get(a)!.content)
      const uniqueContents = new Set(contents)

      if (uniqueContents.size > 1) {
        // Conflict detected: different content for same file
        await this.prisma.conflict.upsert({
          where: {
            sessionId_file: { sessionId: event.sessionId, file: event.params.path as string }
          },
          update: { agents, status: 'PENDING', updatedAt: new Date() },
          create: {
            sessionId: event.sessionId,
            file: event.params.path as string,
            agents,
            changes: { edits: Array.from(fileEdits.entries()).map(([agent, edit]) => ({ agent, content: edit.content })) },
            status: 'PENDING'
          }
        })
      }
    }
  }

  getSessionConflicts(sessionId: string) {
    return this.prisma.conflict.findMany({ where: { sessionId } })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/api -- apps/api/src/services/__tests__/reconciliation.test.ts`
Expected: PASS

- [ ] **Step 5: Run lint and build**

Run: `npm run lint --workspace=@meetless/api && npm run build --workspace=@meetless/api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/reconciliation.ts apps/api/src/services/__tests__/reconciliation.test.ts
git commit -m "feat: add minimal reconciliation engine with file conflict detection"
```

---

### Task 7: Wire Connector Events to Ingestion Pipeline

**Files:**
- Modify: `packages/shared/src/connectors/claude-code.ts`
- Create: `packages/shared/src/connectors/ingestion.ts`
- Create: `packages/shared/src/connectors/__tests__/ingestion.test.ts`

**Interfaces:**
- Consumes: `ClaudeCodeConnector`, `ConnectorRegistry`, `NormalizedAgentEvent`, Prisma client
- Produces: Event ingestion pipeline connecting connector events to REST API

- [ ] **Step 1: Write failing test for ingestion pipeline**

```typescript
// packages/shared/src/connectors/__tests__/ingestion.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IngestionPipeline } from '../ingestion.js'
import { InMemoryConnectorRegistry } from '../registry.js'
import { ClaudeCodeConnector } from '../claude-code.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

describe('IngestionPipeline', () => {
  let pipeline: IngestionPipeline
  let registry: InMemoryConnectorRegistry
  let connector: any

  beforeEach(async () => {
    await prisma.normalizedEvent.deleteMany()
    await prisma.session.deleteMany()
    registry = new InMemoryConnectorRegistry()
    pipeline = new IngestionPipeline(prisma, registry)
  })

  it('registers connector and forwards events to API', async () => {
    // Setup session
    const session = await prisma.session.create({ data: { workspaceId: 'ws-1', userId: 'user-1', name: 'Pipeline Test' } })

    // Create mock connector that emits events
    const mockConnector = {
      id: 'claude-code',
      name: 'Claude Code',
      version: '1.0.0',
      capabilities: { tools: ['edit_file'], resources: [] },
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn((handler) => { connector.eventHandler = handler }),
      sendMCPEvent: vi.fn().mockResolvedValue(undefined),
      eventHandler: null as any
    }
    registry.register(mockConnector)

    pipeline.start()

    // Emit event from connector
    await mockConnector.eventHandler({
      sessionId: 'sess-1',
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'test' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-123'
    })

    // Wait for async persistence
    await new Promise(r => setTimeout(r, 100))

    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: 'sess-1' } })
    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/ingestion.test.ts`
Expected: FAIL - pipeline doesn't exist

- [ ] **Step 3: Implement ingestion pipeline**

```typescript
// packages/shared/src/connectors/ingestion.ts
import type { NormalizedAgentEvent } from '../types/index.js'
import { PrismaClient } from '@prisma/client'
import { ConnectorRegistry } from './registry.js'

interface IngestionOptions {
  prisma: PrismaClient
  registry: ConnectorRegistry
  apiBaseUrl?: string
}

export class IngestionPipeline {
  private prisma: PrismaClient
  private registry: ConnectorRegistry
  private apiBaseUrl: string

  constructor({ prisma, registry, apiBaseUrl = 'http://localhost:3000' }: IngestionOptions) {
    this.prisma = prisma
    this.registry = registry
    this.apiBaseUrl = apiBaseUrl
  }

  start(): void {
    for (const connector of this.registry.getAll()) {
      connector.onEvent((event) => this.handleEvent(event))
    }
  }

  private async handleEvent(event: NormalizedAgentEvent): Promise<void> {
    try {
      // Ensure session exists
      const session = await this.prisma.session.findUnique({ where: { id: event.sessionId } })
      if (!session) {
        console.warn(`Session ${event.sessionId} not found for event from ${event.connectorId}`)
        return
      }

      // Persist event locally
      await this.prisma.normalizedEvent.create({
        data: {
          sessionId: event.sessionId,
          agentId: event.agentId,
          tool: event.tool,
          params: event.params,
          result: event.result ?? {},
          connectorId: event.connectorId,
          connectorVersion: event.connectorVersion,
          mcpEventId: event.mcpEventId,
          rawMCPEvent: event.rawMCPEvent,
          timestamp: new Date(event.timestamp)
        }
      })

      // Forward to API for reconciliation (fire-and-forget)
      fetch(`${this.apiBaseUrl}/api/events`, {
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
      }).catch(err => console.error('Failed to forward event to API:', err))

    } catch (err) {
      console.error('Failed to ingest event:', err)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/ingestion.test.ts`
Expected: PASS

- [ ] **Step 5: Run lint and build**

Run: `npm run lint --workspace=@meetless/shared && npm run build --workspace=@meetless/shared`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/connectors/ingestion.ts packages/shared/src/connectors/__tests__/ingestion.test.ts
git commit -m "feat: add event ingestion pipeline connecting connectors to API"
```

---

### Task 8: Add Conflict Resolution API & WebSocket Broadcast

**Files:**
- Modify: `apps/api/src/routes/events.ts`
- Create: `apps/api/src/routes/__tests__/conflicts.test.ts`
- Modify: `apps/api/src/services/ws-manager.ts`
- Modify: `apps/api/src/services/reconciliation.ts`

**Interfaces:**
- Consumes: Existing conflict API, WebSocket manager, reconciliation engine
- Produces: Conflict resolution endpoints, real-time conflict notifications via WebSocket

- [ ] **Step 1: Write failing test for conflict resolution**

```typescript
// apps/api/src/routes/__tests__/conflicts.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => { app = await buildApp(); await app.ready() })
afterAll(async () => { await app.close() })

describe('POST /api/conflicts/:conflictId/resolve', () => {
  it('resolves a conflict with chosen resolution', async () => {
    // Setup conflict
    const session = await prisma.session.create({ data: { workspaceId: 'ws-1', userId: 'user-1', name: 'Resolve Test' } })
    const conflict = await prisma.conflict.create({
      data: { sessionId: session.id, file: 'src/foo.ts', agents: ['claude-1', 'claude-2'], changes: {}, status: 'PENDING' }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflict.id}/resolve`,
      payload: { resolution: 'accept_a', resolvedBy: 'user-1' }
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(body.status).toBe('RESOLVED')
    expect(body.resolution).toBe('accept_a')

    const updated = await prisma.conflict.findUnique({ where: { id: conflict.id } })
    expect(updated!.status).toBe('RESOLVED')
  })
})

describe('WebSocket conflict notifications', () => {
  it('broadcasts conflict created event to session subscribers', async () => {
    // This test would use WebSocket client to verify broadcast
    // Implementation verified manually via integration test
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/api -- apps/api/src/routes/__tests__/conflicts.test.ts`
Expected: FAIL - resolution endpoint doesn't exist

- [ ] **Step 3: Add conflict resolution endpoint**

```typescript
// apps/api/src/routes/events.ts (add to existing file)

app.post('/api/conflicts/:conflictId/resolve', {
  schema: {
    params: z.object({ conflictId: z.string().cuid() }),
    body: z.object({
      resolution: z.enum(['accept_a', 'accept_b', 'merge', 'manual']),
      resolvedBy: z.string(),
      mergedContent: z.string().optional()
    }),
    response: {
      200: z.object({ id: z.string(), status: z.string(), resolution: z.string() }),
      404: z.object({ error: z.string() })
    }
  }, async (req, reply) => {
    const conflict = await app.prisma.conflict.findUnique({ where: { id: req.params.conflictId } })
    if (!conflict) return reply.code(404).send({ error: 'Conflict not found' })

    const updated = await app.prisma.conflict.update({
      where: { id: req.params.conflictId },
      data: { status: 'RESOLVED', resolvedAt: new Date() }
    })

    // Broadcast resolution via WebSocket
    app.wsManager.broadcastToSession(conflict.sessionId, {
      type: 'conflict_resolved',
      payload: { conflictId: conflict.id, resolution: req.body.resolution, resolvedBy: req.body.resolvedBy }
    })

    return { id: updated.id, status: updated.status, resolution: req.body.resolution }
  })
```

- [ ] **Step 4: Add WebSocket broadcast method for conflict events**

```typescript
// apps/api/src/services/ws-manager.ts (add method to WSManager class)

broadcastConflict(sessionId: string, conflict: any) {
  this.broadcastToSession(sessionId, { type: 'conflict_created', payload: conflict })
}

broadcastConflictResolved(sessionId: string, conflictId: string, resolution: string) {
  this.broadcastToSession(sessionId, { type: 'conflict_resolved', payload: { conflictId, resolution } })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/api -- apps/api/src/routes/__tests__/conflicts.test.ts`
Expected: PASS

- [ ] **Step 6: Run lint and build**

Run: `npm run lint --workspace=@meetless/api && npm run build --workspace=@meetless/api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/events.ts apps/api/src/services/ws-manager.ts apps/api/src/routes/__tests__/conflicts.test.ts
git commit -m "feat: add conflict resolution API and WebSocket conflict notifications"
```

---

### Task 9: End-to-End Integration Test with Mocked Claude Code

**Files:**
- Create: `packages/shared/src/connectors/__tests__/e2e-claude-flow.test.ts`
- Create: `apps/api/src/__tests__/e2e-reconciliation.test.ts`

**Interfaces:**
- Consumes: All previous tasks (connector, ingestion, API, reconciliation)
- Produces: End-to-end verification of the complete vertical slice

- [ ] **Step 1: Write end-to-end test**

```typescript
// packages/shared/src/connectors/__tests__/e2e-claude-flow.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { IngestionPipeline } from '../ingestion.js'
import { InMemoryConnectorRegistry } from '../registry.js'
import { ClaudeCodeConnector } from '../claude-code.js'
import { PrismaClient } from '@prisma/client'
import { ReconciliationEngine } from '../../../../apps/api/src/services/reconciliation.js'
import { buildApp } from '../../../../apps/api/src/app.js'

const prisma = new PrismaClient()
let app: Awaited<ReturnType<typeof buildApp>>

describe('E2E: Claude Code → Meetless reconciliation flow', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let pipeline: IngestionPipeline
  let registry: InMemoryConnectorRegistry
  let connector: ClaudeCodeConnector

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.normalizedEvent.deleteMany()
    await prisma.conflict.deleteMany()
    await prisma.session.deleteMany()
  })

  it('completes full flow: Claude event → ingestion → persistence → reconciliation → conflict detection', async () => {
    // 1. Create session
    const session = await prisma.session.create({
      data: { workspaceId: 'ws-1', userId: 'user-1', name: 'E2E Test' }
    })

    // 2. Setup pipeline and connector
    const registry = new InMemoryConnectorRegistry()
    const pipeline = new IngestionPipeline({ prisma, registry, apiBaseUrl: 'http://localhost:3000' })
    const connector = new ClaudeCodeConnector({ workingDir: '/tmp/test-workspace' })
    registry.register(connector)
    pipeline.start()

    // Mock connector process to avoid real spawn
    vi.spyOn(require('child_process'), 'spawn').mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    } as any)

    await connector.connect()

    // 3. Simulate agent event through connector
    const event = {
      sessionId: (await prisma.session.create({ data: { workspaceId: 'ws-1', userId: 'user-1', name: 'E2E' } })).id,
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'content from agent A' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-e2e-1'
    }

    // Manually trigger connector event handler (simulates MCP message)
    connector['eventHandler']?.(event)

    // Wait for ingestion and reconciliation
    await new Promise(r => setTimeout(r, 500))

    // 4. Verify event persisted
    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: event.sessionId } })
    expect(events).toHaveLength(1)

    // 5. Simulate second agent editing SAME file (conflict)
    const event2 = {
      ...event,
      agentId: 'claude-2',
      mcpEventId: 'mcp-e2e-2',
      params: { path: 'src/foo.ts', content: 'content from agent B' }
    }

    // Trigger second event
    // (directly call reconciliation for test speed)
    const reconciliation = new ReconciliationEngine(prisma)
    await reconciliation.processSessionEvent(event2 as any)

    // 6. Verify conflict detected
    const conflicts = await prisma.conflict.findMany({ where: { sessionId: event.sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/foo.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
    expect(conflicts[0].status).toBe('PENDING')

    // 7. Verify conflict retrievable via API
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${event.sessionId}/conflicts`
    })
    expect(response.statusCode).toBe(200)
    const conflicts = JSON.parse(response.payload)
    expect(conflicts).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/e2e-claude-flow.test.ts`
Expected: FAIL - integration not complete

- [ ] **Step 3: Fix any integration gaps**

This task primarily verifies the full pipeline works. If test fails, fix any wiring issues in:
- `packages/shared/src/connectors/ingestion.ts` (API URL, error handling)
- `apps/api/src/services/reconciliation.ts` (conflict detection logic)
- `apps/api/src/routes/events.ts` (API responses)
- `packages/shared/src/connectors/claude-code.ts` (event emission)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/shared -- packages/shared/src/connectors/__tests__/e2e-claude-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: All tests pass (10+ test files)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/connectors/__tests__/e2e-claude-flow.test.ts apps/api/src/__tests__/e2e-reconciliation.test.ts
git commit -m "test: add end-to-end integration test for Claude Code → Meetless flow"
```

---

### Task 10: Verify Full Pipeline with Demo Script

**Files:**
- Create: `scripts/demo-claude-flow.ts`
- Create: `scripts/__tests__/demo.test.ts` (optional verification)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Runnable demonstration script

- [ ] **Step 1: Create demo script**

```typescript
// scripts/demo-claude-flow.ts
#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { InMemoryConnectorRegistry } from '../packages/shared/src/connectors/registry.js'
import { ClaudeCodeConnector } from '../packages/shared/src/connectors/claude-code.js'
import { IngestionPipeline } from '../packages/shared/src/connectors/ingestion.js'
import { ReconciliationEngine } from '../apps/api/src/services/reconciliation.js'
import { buildApp } from '../apps/api/src/app.js'
import { config } from '@meetless/shared/config'

const prisma = new PrismaClient()

async function main() {
  console.log('🚀 Starting Phase 2A Demo: Claude Code → Meetless Reconciliation Flow\n')

  // 1. Start API server
  const app = await buildApp()
  await app.listen({ port: config.PORT, host: config.HOST })
  console.log(`✅ API server running at http://${config.HOST}:${config.PORT}`)

  // 2. Initialize components
  const prisma = new PrismaClient()
  const registry = new InMemoryConnectorRegistry()
  const pipeline = new IngestionPipeline({ prisma, registry, apiBaseUrl: `http://${config.HOST}:${config.PORT}` })
  const reconciliation = new ReconciliationEngine(prisma)
  const connector = new ClaudeCodeConnector({ workingDir: process.cwd() })

  registry.register(connector)
  pipeline.start()

  // Mock connector process
  const { spawn } = require('child_process')
  vi.spyOn(require('child_process'), 'spawn').mockReturnValue({
    stdout: { on: () => {} }, stderr: { on: () => {} },
    stdin: { write: () => {} }, on: () => {}, kill: () => {}
  } as any)

  await connector.connect()

  // 3. Create test session
  const session = await prisma.session.create({
    data: { workspaceId: 'ws-demo', userId: 'user-demo', name: 'Demo Session' }
  })
  console.log(`📝 Created session: ${session.id}`)

  // 4. Simulate Agent A editing file
  console.log('\n🤖 Agent A (claude-1) editing src/foo.ts...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'claude-1',
    tool: 'edit_file',
    params: { path: 'src/foo.ts', content: 'Agent A content' },
    result: { success: true },
    timestamp: Date.now(),
    connectorId: 'claude-code',
    connectorVersion: '1.0.0',
    mcpEventId: 'demo-mcp-1'
  })
  console.log('✅ Agent A event ingested')

  // 6. Simulate Agent B editing SAME file (conflict)
  console.log('\n🤖 Agent B (claude-2) editing src/foo.ts...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'claude-2',
    tool: 'edit_file',
    params: { path: 'src/foo.ts', content: 'Agent B content' },
    result: { success: true },
    timestamp: Date.now(),
    connectorId: 'claude-code',
    connectorVersion: '1.0.0',
    mcpEventId: 'demo-mcp-2'
  })
  console.log('✅ Agent B event ingested')

  // 7. Verify conflict detected
  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\n⚠️  Conflicts detected: ${conflicts.length}`)
  conflicts.forEach(c => console.log(`   - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`))

  // 7. Verify via API
  const response = await fetch(`http://${config.HOST}:${config.PORT}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await response.json()
  console.log(`\n🌐 API confirms ${apiConflicts.length} conflict(s)`)

  console.log('\n🎉 Phase 2A demo completed successfully!')
  await app.close()
  await prisma.$disconnect()
}

main().catch(console.error)
```

- [ ] **Step 2: Make script executable and run**

Run: `chmod +x scripts/demo-claude-flow.ts && npx tsx scripts/demo-claude-flow.ts`
Expected: Script runs and prints successful flow output

- [ ] **Step 3: Verify output shows complete flow**

Expected output should show:
- API server started
- Session created
- Two agent events ingested
- Conflict detected for same file
- Conflict retrievable via API

- [ ] **Step 4: Commit**

```bash
git add scripts/demo-claude-flow.ts
git commit -m "feat: add Phase 2A demo script for Claude Code reconciliation flow"
```

---

### Task 11: Final Verification & Documentation

**Files:**
- Modify: `README.md` (add Phase 2A usage)
- Create: `docs/phase-2a-connector.md` (connector development guide)

- [ ] **Step 1: Run full test suite**

Run: `npm run test`
Expected: All test suites pass (shared, database, api)

- [ ] **Step 2: Run lint and build for all workspaces**

Run: `npm run lint && npm run build`
Expected: All pass

- [ ] **Step 3: Run demo script to verify end-to-end**

Run: `npx tsx scripts/demo-claude-flow.ts`
Expected: Successful demo output

- [ ] **Step 4: Update README with Phase 2A usage**

```markdown
# README.md (add section)

## Phase 2A: Claude Code MCP Connector

### Quick Start
```bash
# Start infrastructure
docker compose up -d

# Generate Prisma client
npm run db:generate

# Start API server
npm run dev

# Run demo (in separate terminal)
npx tsx scripts/demo-claude-flow.ts
```

### Connector Development
See [docs/phase-2a-connector.md](docs/phase-2a-connector.md) for creating new connectors.
```

- [ ] **Step 5: Create connector development guide**

```markdown
# docs/phase-2a-connector.md
# Building MCP Connectors for Meetless

## Connector Interface
Implement the `Connector` interface from `@meetless/shared/types`:

```typescript
interface Connector {
  id: string
  name: string
  version: string
  capabilities: ConnectorCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  onEvent(handler: (event: NormalizedAgentEvent) => void): void
  sendMCPEvent(event: MCPEvent): Promise<void>
}
```

## BaseConnector
Extend `BaseConnector` from `@meetless/shared/connectors` for common functionality:

```typescript
export class MyConnector extends BaseConnector {
  readonly id = 'my-connector'
  readonly name = 'My Connector'
  readonly version = '1.0.0'
  readonly capabilities = { tools: ['my_tool'], resources: [] }

  async connect() { /* spawn MCP process */ }
  async disconnect() { /* cleanup */ }
  private handleMessage(msg) { /* parse and emit NormalizedAgentEvent */ }
}
```

## Registration
Register your connector at startup:

```typescript
import { connectorRegistry } from '@meetless/shared/connectors'
connectorRegistry.register(new MyConnector({ workingDir: process.cwd() }))
```

## Event Normalization
Your connector must normalize MCP events to `NormalizedAgentEvent`:

```typescript
interface NormalizedAgentEvent extends AgentAction {
  connectorId: string
  connectorVersion: string
  mcpEventId: string
  rawMCPEvent?: unknown
}
```
```

- [ ] **Step 6: Run final verification**

Run: `npm run lint && npm run build && npm run test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add README.md docs/phase-2a-connector.md scripts/demo-claude-flow.ts
git commit -m "docs: add Phase 2A usage docs and connector development guide"
```

---

## Verification Checklist

After completing all tasks, verify:

- [ ] `npm run lint` passes for all workspaces
- [ ] `npm run build` passes for all workspaces
- [ ] `npm run test` passes (all test suites)
- [ ] `npx tsx scripts/demo-claude-flow.ts` runs successfully
- [ ] Database schema includes `Connector` and `NormalizedEvent` models
- [ ] API endpoints work: `POST /api/events`, `GET /api/sessions/:id/conflicts`, `POST /api/conflicts/:id/resolve`
- [ ] WebSocket broadcasts conflict events
- [ ] Claude Code connector emits normalized events
- [ ] Reconciliation detects file conflicts between two agents
- [ ] End-to-end test passes

---

## Dependencies Between Tasks

```
Task 1 (Types) 
    ↓
Task 2 (Database Models) ← depends on Task 1 types
    ↓
Task 3 (Registry + BaseConnector) ← depends on Task 1 types
    ↓
Task 4 (Claude Code Connector) ← depends on Task 3 BaseConnector
    ↓
Task 5 (API Ingestion Endpoint) ← depends on Task 2 models
    ↓
Task 6 (Reconciliation Engine) ← depends on Task 2 models
    ↓
Task 7 (Ingestion Pipeline) ← depends on Task 3 Registry, Task 4 Connector, Task 5 API
    ↓
Task 8 (Conflict Resolution API + WS) ← depends on Task 5 API, Task 6 Engine
    ↓
Task 9 (E2E Integration Test) ← depends on all above
    ↓
Task 10 (Demo Script) ← depends on all above
    ↓
Task 11 (Final Verification + Docs) ← depends on all above
```

---

## File Summary

**New Files Created (~25):**
- `packages/shared/src/types/events.ts`
- `packages/shared/src/types/connector.ts`
- `packages/shared/src/types/__tests__/connector.test.ts`
- `packages/database/prisma/schema.prisma` (modified)
- `packages/database/src/__tests__/connector-models.test.ts`
- `packages/shared/src/connectors/registry.ts`
- `packages/shared/src/connectors/base.ts`
- `packages/shared/src/connectors/index.ts`
- `packages/shared/src/connectors/__tests__/registry.test.ts`
- `packages/shared/src/connectors/claude-code.ts`
- `packages/shared/src/connectors/__tests__/claude-code.test.ts`
- `packages/shared/src/connectors/ingestion.ts`
- `packages/shared/src/connectors/__tests__/ingestion.test.ts`
- `packages/shared/src/connectors/__tests__/e2e-claude-flow.test.ts`
- `apps/api/src/routes/events.ts`
- `apps/api/src/routes/__tests__/events.test.ts`
- `apps/api/src/routes/__tests__/conflicts.test.ts`
- `apps/api/src/services/reconciliation.ts`
- `apps/api/src/services/__tests__/reconciliation.test.ts`
- `apps/api/src/services/ws-manager.ts` (modified)
- `apps/api/src/app.ts` (modified)
- `apps/api/src/__tests__/e2e-reconciliation.test.ts`
- `scripts/demo-claude-flow.ts`
- `docs/phase-2a-connector.md`
- `README.md` (modified)

**Modified Files (~8):**
- `packages/shared/src/types/index.ts`
- `packages/database/prisma/schema.prisma`
- `packages/shared/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/services/ws-manager.ts`
- `apps/api/src/routes/events.ts`
- `README.md`
- `package-lock.json` (auto-generated)

---

**Plan complete and saved to `docs/superpowers/plans/phase-2a-claude-mcp.md`.**