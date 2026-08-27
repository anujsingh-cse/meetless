# Phase 2B: Codex MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex CLI MCP adapter that conforms to the existing connector abstraction and feeds normalized events into the existing ingestion/reconciliation pipeline.

**Architecture:** Spawn `codex mcp-server` as a child process (same pattern as Claude Code connector). Parse stdout line-delimited JSON-RPC. Codex exposes high-level `codex`/`codex-reply` tools — individual file edits arrive as `notifications/progress` with `codex/event` payloads. The adapter normalizes each file-edit/shell event into `NormalizedAgentEvent` with `connectorId: 'codex-cli'`.

**Tech Stack:** TypeScript, Node.js child_process, Vitest, existing `@meetless/shared` connector abstraction.

**Spec:** `docs/superpowers/plans/2026-08-24-meetless-project-brief.md` (MVP row: MCP Connector Framework — Codex)

## Global Constraints

- TypeScript strict mode
- Vitest for testing
- Conventional Commits format
- Trailing newline at EOF on every new file
- TDD: write failing test first, then implement, verify green
- Never use Unix `mkdir -p` (Windows PowerShell environment)
- Reuse existing `BaseConnector`, `ConnectorRegistry`, `IngestionPipeline` — do NOT redesign the connector abstraction
- Do NOT modify the reconciliation engine unless an actual incompatibility is discovered
- Do NOT implement: Cursor, OpenCode, auth/RBAC, dashboard, tunnel, bidirectional approval, session-ID injection, Codex-specific config

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/shared/src/connectors/codex-cli.ts` | **Create** — Codex CLI connector: spawn, parse, normalize |
| `packages/shared/src/connectors/__tests__/codex-cli.test.ts` | **Create** — Unit tests (mocked child_process) |
| `packages/shared/src/connectors/index.ts` | **Modify** — Add CodexCliConnector re-export |
| `apps/api/scripts/demo-codex-connector.ts` | **Create** — Standalone demo script |
| `apps/api/src/__tests__/e2e-multi-connector.test.ts` | **Create** — Cross-connector integration test |
| `apps/api/package.json` | **Modify** — Add `demo:codex` script |
| `docs/project-overview.md` | **Modify** — Add Codex connector section |

No changes needed to: Prisma schema, API routes, reconciliation engine, WebSocket manager, ingestion pipeline. The existing Connector model is generic; `connectorId: 'codex-cli'` auto-creates the DB row via the existing upsert in `events.ts`.

---

## Codex MCP Protocol Reference

Codex CLI exposes `codex mcp-server` — stdio JSON-RPC 2.0.

**Tools exposed:** `codex` (start session) and `codex-reply` (continue session). NOT individual file-edit tools.

**Event streaming:** During execution, the server emits `notifications/progress` messages containing `codex/event` payloads. These include:
- `file_patch` — file modifications (path, patch/diff)
- `shell_exec` — shell command execution (command, output)
- `message` — agent text output

**Our normalization strategy:**
- `file_patch` → `NormalizedAgentEvent` with `tool: 'edit_file'`, params: `{ path, patch }`
- `shell_exec` → `NormalizedAgentEvent` with `tool: 'bash'`, params: `{ command, output }`
- `message` → skip (text output, not an actionable tool call)
- Session-level events (`session_started`, `session_completed`) → skip (not file-level operations)

---

### Task 1: CodexCliConnector Implementation

**Files:**
- Create: `packages/shared/src/connectors/codex-cli.ts`
- Test: `packages/shared/src/connectors/__tests__/codex-cli.test.ts`

**Interfaces:**
- Consumes: `BaseConnector` from `./base.js`, `NormalizedAgentEvent` / `MCPEvent` / `ConnectorCapabilities` from `../types/index.js`
- Produces: `CodexCliConnector` class (exported), usable with `ConnectorRegistry.register()` and `IngestionPipeline`

- [ ] **Step 1: Write the failing test file**

Create `packages/shared/src/connectors/__tests__/codex-cli.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import child_process from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { CodexCliConnector } from '../codex-cli.js'
import type { NormalizedAgentEvent } from '../../types/index.js'

describe('CodexCliConnector', () => {
  let connector: CodexCliConnector
  let mockProcess: {
    stdin: { write: ReturnType<typeof vi.fn> }
    stdout: { on: ReturnType<typeof vi.fn> }
    stderr: { on: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockProcess = {
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    }
    vi.spyOn(child_process, 'spawn').mockReturnValue(
      mockProcess as unknown as ChildProcessWithoutNullStreams
    )
    connector = new CodexCliConnector({ workingDir: '/test/workspace' })
  })

  it('initializes with correct metadata', () => {
    expect(connector.id).toBe('codex-cli')
    expect(connector.name).toBe('Codex CLI')
    expect(connector.capabilities.tools).toContain('file_patch')
    expect(connector.capabilities.tools).toContain('shell_exec')
  })

  it('spawns codex mcp-server on connect', async () => {
    await connector.connect()
    expect(vi.mocked(child_process.spawn)).toHaveBeenCalledWith(
      'codex',
      ['mcp-server'],
      expect.objectContaining({ cwd: '/test/workspace' })
    )
  })

  it('normalizes file_patch event to edit_file NormalizedAgentEvent', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        value: {
          type: 'codex/event',
          event: {
            type: 'file_patch',
            path: 'src/app.ts',
            patch: '@@ -1,3 +1,4 @@\n+import foo'
          }
        }
      }
    }))

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].params).toEqual({ path: 'src/app.ts', patch: '@@ -1,3 +1,4 @@\n+import foo' })
    expect(events[0].connectorId).toBe('codex-cli')
    expect(events[0].connectorVersion).toBe('1.0.0')
    expect(events[0].mcpEventId).toContain('codex-')
    expect(events[0].rawMCPEvent).toBeDefined()
  })

  it('normalizes shell_exec event to bash NormalizedAgentEvent', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-2',
        value: {
          type: 'codex/event',
          event: {
            type: 'shell_exec',
            command: 'npm test',
            output: '3 passing'
          }
        }
      }
    }))

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('bash')
    expect(events[0].params).toEqual({ command: 'npm test', output: '3 passing' })
    expect(events[0].connectorId).toBe('codex-cli')
  })

  it('skips message events (text output)', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-3',
        value: {
          type: 'codex/event',
          event: { type: 'message', content: 'Done!' }
        }
      }
    }))

    expect(events).toHaveLength(0)
  })

  it('skips non-codex-event progress notifications', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-4', value: { percentage: 50 } }
    }))

    expect(events).toHaveLength(0)
  })

  it('generates unique mcpEventId per event', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-5', value: { type: 'codex/event', event: { type: 'file_patch', path: 'a.ts', patch: 'x' } } }
    }))
    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-6', value: { type: 'codex/event', event: { type: 'file_patch', path: 'b.ts', patch: 'y' } } }
    }))

    expect(events).toHaveLength(2)
    expect(events[0].mcpEventId).not.toBe(events[1].mcpEventId)
  })

  it('disconnects and kills process', async () => {
    await connector.connect()
    const proc = connector['process']
    await connector.disconnect()
    expect(proc?.kill).toHaveBeenCalled()
  })

  it('resets buffer on disconnect', async () => {
    await connector.connect()
    connector['buffer'] = 'partial-data'
    await connector.disconnect()
    expect(connector['buffer']).toBe('')
  })

  it('ignores malformed JSON lines', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage']('not valid json {{{')
    connector['handleMCPMessage']('')

    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@meetless/shared -- --reporter=verbose codex-cli`
Expected: FAIL — `Cannot find module '../codex-cli.js'`

- [ ] **Step 3: Implement the connector**

Create `packages/shared/src/connectors/codex-cli.ts`:

```typescript
import childProcess from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { BaseConnector } from './base.js'
import type { NormalizedAgentEvent, MCPEvent, ConnectorCapabilities } from '../types/index.js'

interface MCPMessage {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

interface CodexEvent {
  type: string
  path?: string
  patch?: string
  command?: string
  output?: string
  content?: string
}

export class CodexCliConnector extends BaseConnector {
  readonly id = 'codex-cli'
  readonly name = 'Codex CLI'
  readonly version = '1.0.0'
  readonly capabilities: ConnectorCapabilities = {
    tools: ['file_patch', 'shell_exec'],
    resources: ['file://*']
  }

  private process: ChildProcessWithoutNullStreams | null = null
  buffer = ''
  private workingDir: string
  private eventCounter = 0

  constructor(options: { workingDir: string }) {
    super()
    this.workingDir = options.workingDir
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = childProcess.spawn('codex', ['mcp-server'], {
        cwd: this.workingDir,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      this.process.stdout.on('data', (data) => this.handleStdout(data))
      this.process.stderr.on('data', (data) => console.error('[Codex MCP stderr]', data.toString()))
      this.process.on('error', reject)
      this.process.on('close', (code) => {
        if (code !== 0) console.error(`Codex CLI exited with code ${code}`)
      })

      setTimeout(resolve, 1000)
    })
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
    this.buffer = ''
  }

  async sendMCPEvent(event: MCPEvent): Promise<void> {
    if (!this.process) throw new Error('Not connected')
    const msg: MCPMessage = {
      jsonrpc: '2.0',
      id: event.id,
      method: event.type === 'tool_call' ? 'tools/call' : 'resources/read',
      params: event.payload as Record<string, unknown>
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n')
  }

  private handleStdout(data: Buffer): void {
    this.buffer += data.toString()
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.trim()) {
        this.handleMCPMessage(line)
      }
    }
  }

  handleMCPMessage(raw: MCPMessage | string): void {
    let msg: MCPMessage | null
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw) as MCPMessage
      } catch {
        return
      }
    } else {
      msg = raw
    }

    if (!msg || msg.method !== 'notifications/progress' || !msg.params) return

    const value = msg.params.value as Record<string, unknown> | undefined
    if (!value || value.type !== 'codex/event') return

    const event = value.event as CodexEvent | undefined
    if (!event) return

    const normalized = this.normalizeCodexEvent(event)
    if (normalized) this.emitEvent(normalized)
  }

  private normalizeCodexEvent(event: CodexEvent): NormalizedAgentEvent | null {
    this.eventCounter++
    const mcpEventId = `codex-${Date.now()}-${this.eventCounter}`

    switch (event.type) {
      case 'file_patch':
        return {
          sessionId: '',
          agentId: `codex-${this.process?.pid ?? 'unknown'}`,
          tool: 'edit_file',
          params: { path: event.path, patch: event.patch },
          result: null,
          timestamp: Date.now(),
          connectorId: this.id,
          connectorVersion: this.version,
          mcpEventId,
          rawMCPEvent: event
        }
      case 'shell_exec':
        return {
          sessionId: '',
          agentId: `codex-${this.process?.pid ?? 'unknown'}`,
          tool: 'bash',
          params: { command: event.command, output: event.output },
          result: null,
          timestamp: Date.now(),
          connectorId: this.id,
          connectorVersion: this.version,
          mcpEventId,
          rawMCPEvent: event
        }
      default:
        return null
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@meetless/shared -- --reporter=verbose codex-cli`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/connectors/codex-cli.ts packages/shared/src/connectors/__tests__/codex-cli.test.ts
git commit -m "feat: add Codex CLI MCP connector with event normalization"
```

---

### Task 2: Connector Re-export

**Files:**
- Modify: `packages/shared/src/connectors/index.ts`

**Interfaces:**
- Consumes: `CodexCliConnector` from `./codex-cli.js` (Task 1)
- Produces: `CodexCliConnector` available via `import { CodexCliConnector } from '@meetless/shared/connectors'`

- [ ] **Step 1: Add re-export**

Edit `packages/shared/src/connectors/index.ts` — add one line:

```typescript
export * from './registry.js'
export * from './base.js'
export * from './ingestion.js'
export { ClaudeCodeConnector } from './claude-code.js'
export { CodexCliConnector } from './codex-cli.js'
```

- [ ] **Step 2: Verify build**

Run: `npm run build --workspace=@meetless/shared`
Expected: PASS (tsc compiles without errors)

- [ ] **Step 3: Run all shared tests**

Run: `npm run test --workspace=@meetless/shared`
Expected: All tests PASS (existing + new codex-cli tests)

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/connectors/index.ts
git commit -m "feat: export CodexCliConnector from shared connectors barrel"
```

---

### Task 3: Demo Script

**Files:**
- Create: `apps/api/scripts/demo-codex-connector.ts`
- Modify: `apps/api/package.json` (add `demo:codex` script)

**Interfaces:**
- Consumes: `CodexCliConnector`, `IngestionPipeline`, `InMemoryConnectorRegistry` from `@meetless/shared/connectors`; `buildApp` from `../src/app.js`; `PrismaClient` from `@prisma/client`
- Produces: Runnable demo via `npm run demo:codex --workspace=@meetless/api`

- [ ] **Step 1: Write the demo script**

Create `apps/api/scripts/demo-codex-connector.ts`:

```typescript
#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { CodexCliConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Codex CLI Connector Demo ===\n')

  // 1. Start API server on an ephemeral port
  const app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`API server running at ${baseUrl}`)

  // 2. Seed prerequisite rows
  const team = await prisma.team.create({ data: { name: 'Codex Demo Team', slug: `codex-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_codex_${Date.now()}`, email: `codex-demo-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Codex Demo Workspace' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'Codex Demo Session' } })
  console.log(`Session created: ${session.id}`)

  // 3. Set up connector + pipeline
  const registry = new InMemoryConnectorRegistry()
  const connector = new CodexCliConnector({ workingDir: process.cwd() })
  registry.register(connector)
  const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })

  // 4. Mock child_process.spawn (plain object, no vi)
  const childProcess = await import('child_process')
  const origSpawn = childProcess.spawn
  const mockProc = {
    stdin: { write(_data: string) {} },
    stdout: { on(_evt: string, _cb: (...args: unknown[]) => void) {} },
    stderr: { on(_evt: string, _cb: (...args: unknown[]) => void) {} },
    on(_evt: string, _cb: (...args: unknown[]) => void) {},
    kill() {}
  }
  childProcess.spawn = (() => mockProc) as typeof childProcess.spawn

  await connector.connect()
  console.log('Connector connected (mocked)')

  // 5. Simulate Agent A editing a file via Codex
  console.log('\nAgent A (Codex) editing src/app.ts ...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'codex-1',
    tool: 'edit_file',
    params: { path: 'src/app.ts', patch: '@@ -1,3 +1,4 @@\n+import codex' },
    result: null,
    timestamp: Date.now(),
    connectorId: 'codex-cli',
    connectorVersion: '1.0.0',
    mcpEventId: 'codex-demo-1'
  })
  console.log('Agent A event ingested')

  // 6. Simulate Agent B (Claude) editing the SAME file (cross-connector conflict)
  console.log('\nAgent B (Claude) editing src/app.ts ...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'claude-1',
    tool: 'edit_file',
    params: { path: 'src/app.ts', content: 'function main() { return "B" }' },
    result: { success: true },
    timestamp: Date.now(),
    connectorId: 'claude-code',
    connectorVersion: '1.0.0',
    mcpEventId: 'claude-demo-1'
  })
  console.log('Agent B event ingested')

  // 7. Verify conflicts via DB
  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  // 8. Verify via API
  const resp = await fetch(`${baseUrl}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await resp.json()
  console.log(`\nAPI GET /api/sessions/${session.id}/conflicts returned ${apiConflicts.length} conflict(s)`)

  // 9. Clean up
  childProcess.spawn = origSpawn
  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Add demo:codex script to package.json**

Edit `apps/api/package.json` — add to `"scripts"`:

```json
"demo:codex": "npx tsx scripts/demo-codex-connector.ts"
```

- [ ] **Step 3: Verify build**

Run: `npm run build --workspace=@meetless/api`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/demo-codex-connector.ts apps/api/package.json
git commit -m "feat: add Codex CLI connector demo script"
```

---

### Task 4: Cross-Connector Integration Test

**Files:**
- Create: `apps/api/src/__tests__/e2e-multi-connector.test.ts`

**Interfaces:**
- Consumes: `buildApp` from `../app.js`, `prisma` from `@meetless/database/client`, `CodexCliConnector` + `ClaudeCodeConnector` + `IngestionPipeline` + `InMemoryConnectorRegistry` from `@meetless/shared/connectors`
- Produces: Verified cross-connector conflict detection in a shared session

- [ ] **Step 1: Write the integration test**

Create `apps/api/src/__tests__/e2e-multi-connector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { CodexCliConnector, ClaudeCodeConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

let app: Awaited<ReturnType<typeof buildApp>>
let baseUrl: string
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'Multi Team', slug: `multi-team-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_multi_${randSuffix()}`, email: `multi-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'Multi Workspace' } })).id

  app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`
  } else {
    throw new Error('Server not listening')
  }
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.session.deleteMany()
  await prisma.connector.deleteMany()
})

async function createSession(name: string) {
  return prisma.session.create({ data: { workspaceId, userId, name } })
}

describe('E2E: Multi-connector conflict detection', () => {
  it('detects conflict between Codex and Claude editing the same file', async () => {
    const session = await createSession('Multi-Connector Test')

    // Ensure both connector rows exist
    await prisma.connector.upsert({
      where: { id: 'codex-cli' },
      update: {},
      create: { id: 'codex-cli', name: 'Codex CLI', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' },
      update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
    })

    // Agent A (Codex) edits src/app.ts
    const agentA = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'codex-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', patch: '@@ -1 +1,2 @@\n+import codex' },
        result: null,
        connectorId: 'codex-cli',
        connectorVersion: '1.0.0',
        mcpEventId: `multi-codex-${randSuffix()}`
      }
    })
    expect(agentA.statusCode).toBe(201)

    // Agent B (Claude) edits same file with different content
    const agentB = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'function main() { return "B" }' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `multi-claude-${randSuffix()}`
      }
    })
    expect(agentB.statusCode).toBe(201)

    // Verify both events persisted
    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: session.id } })
    expect(events).toHaveLength(2)
    expect(events.map(e => e.connectorId).sort()).toEqual(['claude-code', 'codex-cli'])

    // Verify conflict detected
    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['codex-1', 'claude-1']))
    expect(conflicts[0].status).toBe('PENDING')

    // Verify via API
    const resp = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/conflicts` })
    expect(resp.statusCode).toBe(200)
    const apiConflicts = JSON.parse(resp.payload)
    expect(apiConflicts).toHaveLength(1)
    expect(apiConflicts[0].agents).toEqual(expect.arrayContaining(['codex-1', 'claude-1']))
  })

  it('no conflict when Codex and Claude edit different files', async () => {
    const session = await createSession('Different Files Test')

    await prisma.connector.upsert({
      where: { id: 'codex-cli' },
      update: {},
      create: { id: 'codex-cli', name: 'Codex CLI', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' },
      update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
    })

    await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'codex-1',
        tool: 'edit_file',
        params: { path: 'src/a.ts', patch: 'x' },
        result: null,
        connectorId: 'codex-cli',
        connectorVersion: '1.0.0',
        mcpEventId: `diff-codex-${randSuffix()}`
      }
    })

    await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/b.ts', content: 'y' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `diff-claude-${randSuffix()}`
      }
    })

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it passes (with Docker)**

Run: `$env:DATABASE_URL="postgresql://meetless:meetless@localhost:5432/meetless"; npm run test --workspace=@meetless/api -- --reporter=verbose multi-connector`
Expected: 2 tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/e2e-multi-connector.test.ts
git commit -m "test: add cross-connector integration test for Codex + Claude conflict detection"
```

---

### Task 5: Documentation Update

**Files:**
- Modify: `docs/project-overview.md`

**Interfaces:**
- Consumes: All prior tasks
- Produces: Updated documentation reflecting Codex connector availability

- [ ] **Step 1: Update project-overview.md**

Edit `docs/project-overview.md`:

1. Add Codex connector row to the Phase 2A table (rename section to "Phase 2A-2B"):

After the existing Claude Code connector row, add:

```markdown
| **Codex CLI connector** | Spawns Codex CLI in MCP server mode, normalizes `file_patch` and `shell_exec` events from `codex/event` notifications |
```

2. Update the API Routes table — no changes needed (routes are generic, `connectorId` field handles both).

3. Add to Connector Development section:

```markdown
### Available Connectors

| Connector | ID | Tools | Status |
|-----------|----|-------|--------|
| Claude Code | `claude-code` | `edit_file`, `read_file`, `list_files`, `grep`, `todo_write`, `bash` | ✅ |
| Codex CLI | `codex-cli` | `file_patch` → `edit_file`, `shell_exec` → `bash` | ✅ |
```

4. Add demo command:

```bash
# Run Codex demo (separate terminal)
npm run demo:codex --workspace=@meetless/api
```

- [ ] **Step 2: Verify no broken links or formatting**

Read the file back and verify markdown renders correctly.

- [ ] **Step 3: Commit**

```bash
git add docs/project-overview.md
git commit -m "docs: add Codex CLI connector to project overview"
```

---

## Verification Gate (Final)

Before reporting done, from repo root with Docker running:

```powershell
$env:DATABASE_URL="postgresql://meetless:meetless@localhost:5432/meetless"
npm run lint
npm run build
npm run test --workspace=@meetless/shared
npm run test --workspace=@meetless/api
```

All must pass. Expected totals:
- `@meetless/shared`: 6+ test files, 25+ tests
- `@meetless/api`: 9+ test files, 22+ tests
- Lint: 3/3 packages
- Build: 3/3 packages
