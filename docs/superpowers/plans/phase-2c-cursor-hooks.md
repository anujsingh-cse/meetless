# Phase 2C: Cursor Hooks Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CursorHooksConnector that captures Cursor IDE agent activity via Cursor's native hooks system, normalizes events into the same NormalizedAgentEvent format used by Claude Code and Codex CLI connectors, and feeds them through the existing IngestionPipeline for conflict detection.

**Architecture:** Cursor's hooks system fires external processes for each agent lifecycle event (preToolUse, postToolUse, sessionStart, stop, etc.). The CursorHooksConnector runs a tiny localhost HTTP bridge server. Hook scripts (installed into `~/.cursor/hooks.json`) receive JSON on stdin and POST it to the bridge. The bridge validates auth, normalizes payloads, and emits NormalizedAgentEvent objects through the BaseConnector event system.

**Tech Stack:** TypeScript, Node.js `http` module (bridge), Node.js `crypto` (auth secret), Node.js `fs` (hook installer), Vitest (tests), `fastify` (API), `zod` (payload validation).

**Spec:** `docs/superpowers/plans/2026-08-24-meetless-project-brief.md`

## Global Constraints

- Windows PowerShell environment — never use `mkdir -p`, never check if directory exists before `New-Item -Force`
- `fastify-plugin` (`fp()`) required for all Fastify plugins (encapsulation bug)
- Prisma binaryTargets: `["native", "debian-openssl-3.0.x"]`
- `@meetless/shared` package exports include `require` conditions (CJS compat)
- CI runs `npm run db:generate` then `npm run db:push` before tests
- Reconciliation engine checks both `params.content` AND `params.patch` for conflict detection
- `.superpowers/` is in `.gitignore`; `docs/superpowers/plans/` is tracked
- Existing connector IDs: `claude-code`, `codex-cli` — new connector ID: `cursor-hooks`
- All connectors extend `BaseConnector` from `packages/shared/src/connectors/base.ts`
- E2E tests use `vitest` with `buildApp()` from `apps/api/src/app.ts`
- Demo scripts use `npx tsx scripts/<name>.ts` pattern

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/shared/src/connectors/cursor-hooks/types.ts` | Cursor hook event types, payload interfaces, validation schemas |
| `packages/shared/src/connectors/cursor-hooks/normalizer.ts` | Maps Cursor hook payloads → `NormalizedAgentEvent` |
| `packages/shared/src/connectors/cursor-hooks/bridge.ts` | Localhost HTTP bridge server receiving events from hook scripts |
| `packages/shared/src/connectors/cursor-hooks/hook-installer.ts` | Read/merge/write `~/.cursor/hooks.json` safely |
| `packages/shared/src/connectors/cursor-hooks/connector.ts` | `CursorHooksConnector` extending `BaseConnector` |
| `packages/shared/src/connectors/cursor-hooks/index.ts` | Barrel export for cursor-hooks module |
| `packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts` | Unit tests for normalizer |
| `packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts` | Unit tests for bridge server |
| `packages/shared/src/connectors/cursor-hooks/__tests__/hook-installer.test.ts` | Unit tests for hook installer |
| `packages/shared/src/connectors/cursor-hooks/__tests__/connector.test.ts` | Unit tests for CursorHooksConnector |
| `apps/api/src/__tests__/e2e-cursor-hooks.test.ts` | E2E test: Cursor event → reconciliation → conflict |
| `apps/api/scripts/demo-cursor-hooks.ts` | Demo script showing Cursor → API flow |

### Modified Files

| File | Change |
|------|--------|
| `packages/shared/src/connectors/index.ts` | Add `export { CursorHooksConnector } from './cursor-hooks/index.js'` |
| `apps/api/package.json` | Add `"demo:cursor": "npx tsx scripts/demo-cursor-hooks.ts"` script |
| `docs/project-overview.md` | Add Cursor Hooks connector to Available Connectors table |

---

## Tasks

### Task 1: Cursor Hook Types and Validation

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/types.ts`

**Interfaces:**
- Consumes: (none — foundational task)
- Produces: `CursorHookEvent`, `CursorHookEventName`, `CursorHookPayload`, `BRIDGE_SECRET_HEADER`, `isCursorHookEventName()`

- [ ] **Step 1: Create the types file**

```typescript
// packages/shared/src/connectors/cursor-hooks/types.ts

export const BRIDGE_SECRET_HEADER = 'x-meetless-secret'

export const CURSOR_HOOK_EVENT_NAMES = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'beforeSubmitPrompt',
  'subagentStart',
  'subagentStop',
  'stop',
  'afterAgentResponse',
  'afterAgentThought',
  'preCompact',
] as const

export type CursorHookEventName = (typeof CURSOR_HOOK_EVENT_NAMES)[number]

export function isCursorHookEventName(value: string): value is CursorHookEventName {
  return (CURSOR_HOOK_EVENT_NAMES as readonly string[]).includes(value)
}

export interface CursorHookPayload {
  hook_event_name: string
  timestamp?: string
  cwd?: string
  session_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_output?: string
  error?: string
  // session-level fields
  status?: string
  // subagent fields
  subagent_id?: string
  subagent_name?: string
}

export interface CursorHookEvent {
  hookEventName: CursorHookEventName
  timestamp: string
  cwd: string
  sessionId: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  error?: string
  status?: string
  subagentId?: string
  subagentName?: string
}
```

- [ ] **Step 2: Verify file compiles**

Run: `npm run build --workspace=@meetless/shared`
Expected: Build succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/connectors/cursor-hooks/types.ts
git commit -m "feat(cursor-hooks): add Cursor hook event types and validation"
```

---

### Task 2: Cursor Hook Normalizer

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/normalizer.ts`
- Create: `packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts`

**Interfaces:**
- Consumes: `CursorHookEvent` from Task 1
- Produces: `NormalizedAgentEvent` (from `../../types/index.js`), `normalizeCursorHookEvent()` function

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeCursorHookEvent } from '../normalizer.js'
import type { CursorHookEvent } from '../types.js'

describe('normalizeCursorHookEvent', () => {
  const base: Omit<CursorHookEvent, 'hookEventName'> = {
    timestamp: '2026-08-27T10:00:00Z',
    cwd: '/workspace',
    sessionId: 'sess-1',
  }

  it('maps preToolUse Shell to bash', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Shell',
      toolInput: { command: 'npm test' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('bash')
    expect(result.params).toEqual({ command: 'npm test' })
    expect(result.connectorId).toBe('cursor-hooks')
    expect(result.sessionId).toBe('sess-1')
    expect(result.agentId).toContain('cursor-')
  })

  it('maps preToolUse Write to edit_file', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Write',
      toolInput: { file_path: 'src/app.ts', content: 'new content' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('edit_file')
    expect(result.params).toEqual({ path: 'src/app.ts', content: 'new content' })
  })

  it('maps preToolUse Read to read_file', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Read',
      toolInput: { file_path: 'src/app.ts' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('read_file')
    expect(result.params).toEqual({ path: 'src/app.ts' })
  })

  it('maps preToolUse Grep to grep', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Grep',
      toolInput: { pattern: 'TODO' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('grep')
    expect(result.params).toEqual({ pattern: 'TODO' })
  })

  it('maps preToolUse Task to subagent', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Task',
      toolInput: { description: 'investigate bug' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('subagent')
    expect(result.params).toEqual({ description: 'investigate bug' })
  })

  it('maps preToolUse MCP:* to mcp_tool', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'MCP:github',
      toolInput: { action: 'create_issue' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('mcp_tool')
    expect(result.params).toEqual({ name: 'github', action: 'create_issue' })
  })

  it('maps afterFileEdit to edit_file', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'afterFileEdit',
      toolName: 'Write',
      toolInput: { file_path: 'src/app.ts' },
      toolOutput: 'diff content',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('edit_file')
    expect(result.params).toEqual({ path: 'src/app.ts', content: 'diff content' })
  })

  it('maps beforeShellExecution to bash', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'beforeShellExecution',
      toolInput: { command: 'git status' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('bash')
    expect(result.params).toEqual({ command: 'git status' })
  })

  it('maps afterShellExecution to bash with output', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'afterShellExecution',
      toolInput: { command: 'git status' },
      toolOutput: 'On branch main',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('bash')
    expect(result.params).toEqual({ command: 'git status', output: 'On branch main' })
  })

  it('maps sessionStart to session_init', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'sessionStart',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('session_init')
    expect(result.params).toEqual({})
  })

  it('maps stop to session_end with status', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'stop',
      status: 'completed',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('session_end')
    expect(result.params).toEqual({ status: 'completed' })
  })

  it('maps subagentStart to subagent with start action', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'subagentStart',
      subagentId: 'sub-1',
      subagentName: 'investigator',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result.tool).toBe('subagent')
    expect(result.params).toEqual({ action: 'start', subagentId: 'sub-1', subagentName: 'investigator' })
  })

  it('returns null for unrecognized hook event names', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'afterAgentThought' as CursorHookEvent['hookEventName'],
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).toBeNull()
  })

  it('generates unique mcpEventId per event', () => {
    const event1 = normalizeCursorHookEvent({ ...base, hookEventName: 'sessionStart' }, 'cursor-hooks', '1.0.0')
    const event2 = normalizeCursorHookEvent({ ...base, hookEventName: 'sessionStart' }, 'cursor-hooks', '1.0.0')
    expect(event1?.mcpEventId).not.toBe(event2?.mcpEventId)
  })

  it('includes rawMCPEvent with original payload', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Shell',
      toolInput: { command: 'echo hi' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result?.rawMCPEvent).toEqual(event)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@meetless/shared -- --run normalizer`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the normalizer**

```typescript
// packages/shared/src/connectors/cursor-hooks/normalizer.ts
import type { NormalizedAgentEvent } from '../../types/index.js'
import type { CursorHookEvent, CursorHookEventName } from './types.js'

const CURSOR_TOOL_MAP: Record<string, string> = {
  Shell: 'bash',
  Write: 'edit_file',
  Edit: 'edit_file',
  Read: 'read_file',
  Glob: 'list_files',
  Grep: 'grep',
  Task: 'subagent',
}

let eventCounter = 0

function mapToolName(hookEventName: CursorHookEventName, toolName?: string): string | null {
  if (hookEventName === 'sessionStart') return 'session_init'
  if (hookEventName === 'stop' || hookEventName === 'sessionEnd') return 'session_end'
  if (hookEventName === 'subagentStart' || hookEventName === 'subagentStop') return 'subagent'
  if (hookEventName === 'afterFileEdit') return 'edit_file'
  if (hookEventName === 'beforeShellExecution' || hookEventName === 'afterShellExecution') return 'bash'

  if (!toolName) return null

  if (toolName.startsWith('MCP:')) return 'mcp_tool'

  return CURSOR_TOOL_MAP[toolName] ?? null
}

function extractParams(
  hookEventName: CursorHookEventName,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  toolOutput: string | undefined,
  status: string | undefined,
  subagentId: string | undefined,
  subagentName: string | undefined,
  mappedTool: string
): Record<string, unknown> {
  switch (mappedTool) {
    case 'session_init':
      return {}
    case 'session_end':
      return { status: status ?? 'unknown' }
    case 'subagent':
      if (hookEventName === 'subagentStart') {
        return { action: 'start', subagentId, subagentName }
      }
      if (hookEventName === 'subagentStop') {
        return { action: 'stop', subagentId, subagentName }
      }
      return toolInput ?? {}
    case 'bash': {
      const command = typeof toolInput?.command === 'string' ? toolInput.command : ''
      const params: Record<string, unknown> = { command }
      if (hookEventName === 'afterShellExecution' && toolOutput) {
        params.output = toolOutput
      }
      return params
    }
    case 'edit_file': {
      const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined
      const content = typeof toolInput?.content === 'string' ? toolInput.content : undefined
      const params: Record<string, unknown> = {}
      if (filePath) params.path = filePath
      if (hookEventName === 'afterFileEdit' && toolOutput) {
        params.content = toolOutput
      } else if (content) {
        params.content = content
      }
      return params
    }
    case 'read_file': {
      const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined
      return filePath ? { path: filePath } : (toolInput ?? {})
    }
    case 'grep':
      return toolInput ?? {}
    case 'list_files':
      return toolInput ?? {}
    case 'mcp_tool': {
      const name = toolName?.startsWith('MCP:') ? toolName.slice(4) : toolName
      return { name, ...(toolInput ?? {}) }
    }
    default:
      return toolInput ?? {}
  }
}

export function normalizeCursorHookEvent(
  event: CursorHookEvent,
  connectorId: string,
  connectorVersion: string
): NormalizedAgentEvent | null {
  const mappedTool = mapToolName(event.hookEventName, event.toolName)
  if (!mappedTool) return null

  eventCounter++
  const mcpEventId = `cursor-${Date.now()}-${eventCounter}`
  const agentId = event.sessionId
    ? `cursor-${event.sessionId.slice(0, 8)}`
    : `cursor-${event.cwd?.replace(/[/\\]/g, '-').slice(0, 20) ?? 'unknown'}`

  return {
    sessionId: event.sessionId ?? '',
    agentId,
    tool: mappedTool,
    params: extractParams(
      event.hookEventName,
      event.toolName,
      event.toolInput,
      event.toolOutput,
      event.status,
      event.subagentId,
      event.subagentName,
      mappedTool
    ),
    result: null,
    timestamp: Date.now(),
    connectorId,
    connectorVersion,
    mcpEventId,
    rawMCPEvent: event,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@meetless/shared -- --run normalizer`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/connectors/cursor-hooks/normalizer.ts \
        packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts
git commit -m "feat(cursor-hooks): add Cursor hook event normalizer with tests"
```

---

### Task 3: Hook Installer

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/hook-installer.ts`
- Create: `packages/shared/src/connectors/cursor-hooks/__tests__/hook-installer.test.ts`

**Interfaces:**
- Consumes: (none — standalone utility)
- Produces: `HookInstaller` class with `install()`, `uninstall()`, `getHooksPath()`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/connectors/cursor-hooks/__tests__/hook-installer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { HookInstaller } from '../hook-installer.js'

describe('HookInstaller', () => {
  let tmpDir: string
  let installer: HookInstaller

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-test-'))
    installer = new HookInstaller({
      hooksPath: path.join(tmpDir, 'hooks.json'),
      hookScriptPath: '/path/to/bridge-client.mjs',
      secret: 'test-secret-123',
      bridgePort: 9999,
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates hooks.json when it does not exist', async () => {
    await installer.install()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    expect(content.version).toBe(1)
    expect(content.hooks.preToolUse).toBeDefined()
    expect(content.hooks.preToolUse.length).toBeGreaterThan(0)
    expect(content.hooks.preToolUse[0].command).toContain('bridge-client.mjs')
  })

  it('merges hooks into existing hooks.json without overwriting', async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [{ command: 'my-existing-hook.sh', matcher: '' }],
        postToolUse: [{ command: 'other-hook.sh', matcher: '' }],
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await installer.install()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))

    // Existing hooks preserved
    expect(content.hooks.preToolUse).toHaveLength(2)
    expect(content.hooks.preToolUse[0].command).toBe('my-existing-hook.sh')
    expect(content.hooks.postToolUse[0].command).toBe('other-hook.sh')

    // Meetless hooks added
    const meetlessHook = content.hooks.preToolUse.find((h: { command: string }) =>
      h.command.includes('bridge-client.mjs')
    )
    expect(meetlessHook).toBeDefined()
  })

  it('does not duplicate Meetless hooks on repeated install', async () => {
    await installer.install()
    await installer.install()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    const meetlessHooks = content.hooks.preToolUse.filter((h: { command: string }) =>
      h.command.includes('bridge-client.mjs')
    )
    expect(meetlessHooks).toHaveLength(1)
  })

  it('uninstall removes only Meetless hooks', async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [
          { command: 'my-hook.sh', matcher: '' },
          { command: `node /path/to/bridge-client.mjs --secret test-secret-123 --port 9999 --event preToolUse`, matcher: '' },
        ],
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await installer.uninstall()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    expect(content.hooks.preToolUse).toHaveLength(1)
    expect(content.hooks.preToolUse[0].command).toBe('my-hook.sh')
  })

  it('uninstall removes entire event key if no hooks remain', async () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [
          { command: `node /path/to/bridge-client.mjs --secret test-secret-123 --port 9999 --event preToolUse`, matcher: '' },
        ],
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await installer.uninstall()
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    expect(content.hooks.preToolUse).toBeUndefined()
  })

  it('identifies Meetless hooks by bridge-client.mjs in command', () => {
    expect(installer.isMeetlessHook({ command: 'my-hook.sh', matcher: '' })).toBe(false)
    expect(installer.isMeetlessHook({
      command: 'node /path/to/bridge-client.mjs --secret x --port 1 --event preToolUse',
      matcher: '',
    })).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@meetless/shared -- --run hook-installer`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hook installer**

```typescript
// packages/shared/src/connectors/cursor-hooks/hook-installer.ts
import fs from 'fs'
import path from 'path'
import { CURSOR_HOOK_EVENT_NAMES } from './types.js'

export interface HookInstallerOptions {
  hooksPath: string
  hookScriptPath: string
  secret: string
  bridgePort: number
}

interface HookEntry {
  command: string
  matcher?: string
}

interface HooksFile {
  version: number
  hooks: Record<string, HookEntry[]>
}

const MEETLESS_MARKER = 'bridge-client.mjs'

export class HookInstaller {
  private hooksPath: string
  private hookCommand: string

  constructor(options: HookInstallerOptions) {
    this.hooksPath = options.hooksPath
    this.hookCommand = `node "${options.hookScriptPath}" --secret ${options.secret} --port ${options.bridgePort}`
  }

  getHooksFilePath(): string {
    return this.hooksPath
  }

  isMeetlessHook(entry: HookEntry): boolean {
    return entry.command.includes(MEETLESS_MARKER)
  }

  async install(): Promise<void> {
    let hooksFile: HooksFile
    try {
      const raw = fs.readFileSync(this.hooksPath, 'utf-8')
      hooksFile = JSON.parse(raw) as HooksFile
    } catch {
      hooksFile = { version: 1, hooks: {} }
    }

    if (!hooksFile.hooks) hooksFile.hooks = {}

    for (const eventName of CURSOR_HOOK_EVENT_NAMES) {
      if (!hooksFile.hooks[eventName]) hooksFile.hooks[eventName] = []

      const existing = hooksFile.hooks[eventName].find(h => this.isMeetlessHook(h))
      if (existing) {
        existing.command = `${this.hookCommand} --event ${eventName}`
      } else {
        hooksFile.hooks[eventName].push({
          command: `${this.hookCommand} --event ${eventName}`,
          matcher: '',
        })
      }
    }

    fs.mkdirSync(path.dirname(this.hooksPath), { recursive: true })
    fs.writeFileSync(this.hooksPath, JSON.stringify(hooksFile, null, 2))
  }

  async uninstall(): Promise<void> {
    let hooksFile: HooksFile
    try {
      const raw = fs.readFileSync(this.hooksPath, 'utf-8')
      hooksFile = JSON.parse(raw) as HooksFile
    } catch {
      return
    }

    if (!hooksFile.hooks) return

    for (const eventName of Object.keys(hooksFile.hooks)) {
      hooksFile.hooks[eventName] = hooksFile.hooks[eventName].filter(h => !this.isMeetlessHook(h))
      if (hooksFile.hooks[eventName].length === 0) {
        delete hooksFile.hooks[eventName]
      }
    }

    fs.writeFileSync(this.hooksPath, JSON.stringify(hooksFile, null, 2))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@meetless/shared -- --run hook-installer`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/connectors/cursor-hooks/hook-installer.ts \
        packages/shared/src/connectors/cursor-hooks/__tests__/hook-installer.test.ts
git commit -m "feat(cursor-hooks): add hook installer with safe merge/uninstall"
```

---

### Task 4: Local HTTP Bridge Server

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/bridge.ts`
- Create: `packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: `CursorHookPayload` from Task 1, `normalizeCursorHookEvent` from Task 2
- Produces: `BridgeServer` class with `start()`, `stop()`, `port`, `onEvent()`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { BridgeServer } from '../bridge.js'
import type { NormalizedAgentEvent } from '../../types/index.js'

describe('BridgeServer', () => {
  let bridge: BridgeServer

  beforeEach(() => {
    bridge = new BridgeServer({ secret: 'test-secret', connectorVersion: '1.0.0' })
  })

  afterEach(async () => {
    await bridge.stop()
  })

  it('starts and binds to a port', async () => {
    await bridge.start()
    expect(bridge.port).toBeGreaterThan(0)
    expect(bridge.port).toBeLessThan(65536)
  })

  it('accepts valid hook events with correct secret', async () => {
    const events: NormalizedAgentEvent[] = []
    bridge.onEvent(e => events.push(e))
    await bridge.start()

    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
    })

    const res = await makeRequest(bridge.port, payload, 'test-secret')
    expect(res.statusCode).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('bash')
  })

  it('rejects requests with wrong secret', async () => {
    await bridge.start()

    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
    })

    const res = await makeRequest(bridge.port, payload, 'wrong-secret')
    expect(res.statusCode).toBe(401)
  })

  it('rejects requests with no secret header', async () => {
    await bridge.start()

    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
    })

    const req = http.request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: '/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
      req.end(payload)
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-JSON payloads', async () => {
    await bridge.start()
    const res = await makeRequest(bridge.port, 'not json', 'test-secret')
    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid hook_event_name', async () => {
    await bridge.start()
    const payload = JSON.stringify({
      hook_event_name: 'nonexistent_event',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
    })
    const res = await makeRequest(bridge.port, payload, 'test-secret')
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for non-/hook paths', async () => {
    await bridge.start()
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: '/other',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-meetless-secret': 'test-secret' },
    })
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
      req.end('{}')
    })
    expect(res.statusCode).toBe(404)
  })

  it('stops cleanly', async () => {
    await bridge.start()
    const port = bridge.port
    await bridge.stop()
    // Verify port is freed by trying to bind to it
    const err = await new Promise<Error | null>((resolve) => {
      const server = http.createServer()
      server.listen(port, '127.0.0.1', () => { server.close(() => resolve(null)) })
      server.on('error', resolve)
    })
    expect(err).toBeNull()
  })
})

function makeRequest(port: number, body: string, secret: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-meetless-secret': secret,
      },
    })
    req.on('response', resolve)
    req.on('error', reject)
    req.end(body)
  })
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@meetless/shared -- --run bridge`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the bridge server**

```typescript
// packages/shared/src/connectors/cursor-hooks/bridge.ts
import http from 'http'
import type { NormalizedAgentEvent } from '../../types/index.js'
import type { CursorHookPayload } from './types.js'
import { isCursorHookEventName, BRIDGE_SECRET_HEADER } from './types.js'
import { normalizeCursorHookEvent } from './normalizer.js'

export interface BridgeServerOptions {
  secret: string
  connectorVersion: string
}

export class BridgeServer {
  private server: http.Server | null = null
  private _port = 0
  private secret: string
  private connectorVersion: string
  private eventHandlers: ((event: NormalizedAgentEvent) => void)[] = []

  constructor(options: BridgeServerOptions) {
    this.secret = options.secret
    this.connectorVersion = options.connectorVersion
  }

  get port(): number {
    return this._port
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.eventHandlers.push(handler)
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this._port = addr.port
        }
        resolve()
      })
      this.server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = null
        this._port = 0
        resolve()
      })
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    const providedSecret = req.headers[BRIDGE_SECRET_HEADER]
    if (providedSecret !== this.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      let payload: CursorHookPayload
      try {
        payload = JSON.parse(body) as CursorHookPayload
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      if (!isCursorHookEventName(payload.hook_event_name)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unknown hook event: ${payload.hook_event_name}` }))
        return
      }

      const event = normalizeCursorHookEvent(
        {
          hookEventName: payload.hook_event_name,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          cwd: payload.cwd ?? process.cwd(),
          sessionId: payload.session_id ?? '',
          toolName: payload.tool_name,
          toolInput: payload.tool_input,
          toolOutput: payload.tool_output,
          error: payload.error,
          status: payload.status,
          subagentId: payload.subagent_id,
          subagentName: payload.subagent_name,
        },
        'cursor-hooks',
        this.connectorVersion
      )

      if (event) {
        this.eventHandlers.forEach(h => h(event))
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@meetless/shared -- --run bridge`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/connectors/cursor-hooks/bridge.ts \
        packages/shared/src/connectors/cursor-hooks/__tests__/bridge.test.ts
git commit -m "feat(cursor-hooks): add localhost HTTP bridge server with auth"
```

---

### Task 5: CursorHooksConnector

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/connector.ts`
- Create: `packages/shared/src/connectors/cursor-hooks/__tests__/connector.test.ts`

**Interfaces:**
- Consumes: `BridgeServer` from Task 4, `HookInstaller` from Task 3
- Produces: `CursorHooksConnector` extending `BaseConnector` (from `../base.js`)

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/connectors/cursor-hooks/__tests__/connector.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { CursorHooksConnector } from '../connector.js'

describe('CursorHooksConnector', () => {
  let tmpDir: string
  let connector: CursorHooksConnector

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-conn-'))
    connector = new CursorHooksConnector({
      workingDir: '/test/workspace',
      hooksPath: path.join(tmpDir, 'hooks.json'),
    })
  })

  afterEach(async () => {
    await connector.disconnect()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initializes with correct metadata', () => {
    expect(connector.id).toBe('cursor-hooks')
    expect(connector.name).toBe('Cursor Hooks')
    expect(connector.version).toBe('1.0.0')
    expect(connector.capabilities.tools).toContain('edit_file')
    expect(connector.capabilities.tools).toContain('bash')
    expect(connector.capabilities.tools).toContain('read_file')
  })

  it('connect starts bridge and installs hooks', async () => {
    await connector.connect()
    expect(connector['bridge'].port).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmpDir, 'hooks.json'))).toBe(true)
  })

  it('emits events from bridge through onEvent handlers', async () => {
    const events: import('../../types/index.js').NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))
    await connector.connect()

    // Simulate a hook POST directly to the bridge
    const port = connector['bridge'].port
    const secret = connector['secret']
    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
      tool_name: 'Shell',
      tool_input: { command: 'echo hello' },
    })

    const http = await import('http')
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-meetless-secret': secret,
        },
      })
      req.on('response', (res) => {
        expect(res.statusCode).toBe(200)
        resolve()
      })
      req.on('error', reject)
      req.end(payload)
    })

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('bash')
    expect(events[0].params).toEqual({ command: 'echo hello' })
  })

  it('disconnect stops bridge and uninstalls hooks', async () => {
    await connector.connect()
    const port = connector['bridge'].port
    await connector.disconnect()

    // Bridge should be stopped — port should be freed
    const err = await new Promise<Error | null>((resolve) => {
      const server = require('http').createServer()
      server.listen(port, '127.0.0.1', () => { server.close(() => resolve(null)) })
      server.on('error', resolve)
    })
    expect(err).toBeNull()

    // Hooks file should have Meetless hooks removed
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf-8'))
    const meetlessHooks = Object.values(content.hooks as Record<string, Array<{ command: string }>>)
      .flat()
      .filter(h => h.command.includes('bridge-client.mjs'))
    expect(meetlessHooks).toHaveLength(0)
  })

  it('generates a random secret on construction', () => {
    const conn1 = new CursorHooksConnector({ workingDir: '/a', hooksPath: '/a/hooks.json' })
    const conn2 = new CursorHooksConnector({ workingDir: '/b', hooksPath: '/b/hooks.json' })
    expect(conn1['secret']).toBeTruthy()
    expect(conn2['secret']).toBeTruthy()
    expect(conn1['secret']).not.toBe(conn2['secret'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@meetless/shared -- --run connector`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the CursorHooksConnector**

```typescript
// packages/shared/src/connectors/cursor-hooks/connector.ts
import crypto from 'crypto'
import path from 'path'
import { BaseConnector } from '../base.js'
import type { ConnectorCapabilities } from '../../types/index.js'
import { BridgeServer } from './bridge.js'
import { HookInstaller } from './hook-installer.js'

export interface CursorHooksConnectorOptions {
  workingDir: string
  hooksPath?: string
}

const DEFAULT_HOOKS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  '.cursor',
  'hooks.json'
)

const BRIDGE_CLIENT_SCRIPT = path.join(
  import.meta.dirname ?? '.',
  'bridge-client.mjs'
)

export class CursorHooksConnector extends BaseConnector {
  readonly id = 'cursor-hooks'
  readonly name = 'Cursor Hooks'
  readonly version = '1.0.0'
  readonly capabilities: ConnectorCapabilities = {
    tools: ['edit_file', 'read_file', 'list_files', 'grep', 'bash', 'subagent', 'mcp_tool', 'session_init', 'session_end'],
    resources: ['file://*'],
  }

  private bridge: BridgeServer
  private installer: HookInstaller
  private workingDir: string
  private secret: string

  constructor(options: CursorHooksConnectorOptions) {
    super()
    this.workingDir = options.workingDir
    this.secret = crypto.randomBytes(32).toString('hex')

    this.bridge = new BridgeServer({
      secret: this.secret,
      connectorVersion: this.version,
    })

    this.bridge.onEvent((event) => this.emitEvent(event))

    this.installer = new HookInstaller({
      hooksPath: options.hooksPath ?? DEFAULT_HOOKS_PATH,
      hookScriptPath: BRIDGE_CLIENT_SCRIPT,
      secret: this.secret,
      bridgePort: 0, // Will be updated after bridge starts
    })
  }

  async connect(): Promise<void> {
    await this.bridge.start()

    // Update installer with actual port
    this.installer = new HookInstaller({
      hooksPath: this.installer.getHooksFilePath(),
      hookScriptPath: BRIDGE_CLIENT_SCRIPT,
      secret: this.secret,
      bridgePort: this.bridge.port,
    })

    await this.installer.install()
  }

  async disconnect(): Promise<void> {
    await this.installer.uninstall()
    await this.bridge.stop()
  }
}
```

- [ ] **Step 4: Create the bridge-client.mjs hook script**

This is the script that Cursor spawns for each hook event. It reads JSON from stdin and POSTs to the bridge.

```javascript
// packages/shared/src/connectors/cursor-hooks/bridge-client.mjs
import http from 'http'

const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

const secret = getArg('secret')
const port = getArg('port')

let body = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => { body += chunk })
process.stdin.on('end', () => {
  if (!secret || !port) {
    process.exit(1)
  }

  const req = http.request({
    hostname: '127.0.0.1',
    port: Number(port),
    path: '/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-meetless-secret': secret,
    },
  })

  req.on('response', (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1)
  })

  req.on('error', () => {
    process.exit(1)
  })

  req.end(body)
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test --workspace=@meetless/shared -- --run connector`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/connectors/cursor-hooks/connector.ts \
        packages/shared/src/connectors/cursor-hooks/__tests__/connector.test.ts \
        packages/shared/src/connectors/cursor-hooks/bridge-client.mjs
git commit -m "feat(cursor-hooks): add CursorHooksConnector with bridge + installer"
```

---

### Task 6: Barrel Export

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/index.ts`
- Modify: `packages/shared/src/connectors/index.ts`

**Interfaces:**
- Consumes: `CursorHooksConnector` from Task 5
- Produces: Barrel exports from `@meetless/shared/connectors`

- [ ] **Step 1: Create the cursor-hooks barrel**

```typescript
// packages/shared/src/connectors/cursor-hooks/index.ts
export { CursorHooksConnector } from './connector.js'
export type { CursorHooksConnectorOptions } from './connector.js'
export { BridgeServer } from './bridge.js'
export { HookInstaller } from './hook-installer.js'
export { normalizeCursorHookEvent } from './normalizer.js'
export {
  CURSOR_HOOK_EVENT_NAMES,
  isCursorHookEventName,
  BRIDGE_SECRET_HEADER,
} from './types.js'
export type { CursorHookEvent, CursorHookEventName, CursorHookPayload } from './types.js'
```

- [ ] **Step 2: Add export to connectors/index.ts**

```typescript
// packages/shared/src/connectors/index.ts
export * from './registry.js'
export * from './base.js'
export * from './ingestion.js'
export { ClaudeCodeConnector } from './claude-code.js'
export { CodexCliConnector } from './codex-cli.js'
export { CursorHooksConnector } from './cursor-hooks/index.js'
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build --workspace=@meetless/shared`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/connectors/cursor-hooks/index.ts \
        packages/shared/src/connectors/index.ts
git commit -m "feat(cursor-hooks): add barrel exports for CursorHooksConnector"
```

---

### Task 7: E2E Test — Cursor → Reconciliation → Conflict

**Files:**
- Create: `apps/api/src/__tests__/e2e-cursor-hooks.test.ts`

**Interfaces:**
- Consumes: `CursorHooksConnector` from Task 6, existing API routes from `apps/api/src/routes/events.ts`
- Produces: E2E test proving Cursor events enter the same reconciliation system as Claude/Codex

- [ ] **Step 1: Write the E2E test**

```typescript
// apps/api/src/__tests__/e2e-cursor-hooks.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { CursorHooksConnector } from '@meetless/shared/connectors'

let app: Awaited<ReturnType<typeof buildApp>>
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'Cursor E2E Team', slug: `cursor-e2e-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_cursor_${randSuffix()}`, email: `cursor-e2e-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'Cursor E2E Workspace' } })).id

  app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
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

describe('E2E: Cursor Hooks → reconciliation', () => {
  it('Cursor edit_file event enters reconciliation and detects conflict with Claude', async () => {
    const session = await createSession('Cursor-Claude Conflict Test')

    // Register both connectors in DB
    await prisma.connector.upsert({
      where: { id: 'cursor-hooks' },
      update: {},
      create: { id: 'cursor-hooks', name: 'Cursor Hooks', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' },
      update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
    })

    // Simulate Cursor editing src/app.ts
    const cursorEvent = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'cursor-sess-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'cursor version of the code' },
        connectorId: 'cursor-hooks',
        connectorVersion: '1.0.0',
        mcpEventId: `cursor-e2e-${randSuffix()}`
      }
    })
    expect(cursorEvent.statusCode).toBe(201)

    // Simulate Claude editing the SAME file
    const claudeEvent = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'claude version of the code' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `claude-e2e-${randSuffix()}`
      }
    })
    expect(claudeEvent.statusCode).toBe(201)

    // Verify both events persisted
    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: session.id } })
    expect(events).toHaveLength(2)
    expect(events.map(e => e.connectorId).sort()).toEqual(['claude-code', 'cursor-hooks'])

    // Verify conflict detected
    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['cursor-sess-1', 'claude-1']))
    expect(conflicts[0].status).toBe('PENDING')

    // Verify via API
    const resp = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/conflicts` })
    expect(resp.statusCode).toBe(200)
    const apiConflicts = JSON.parse(resp.payload)
    expect(apiConflicts).toHaveLength(1)
    expect(apiConflicts[0].agents).toEqual(expect.arrayContaining(['cursor-sess-1', 'claude-1']))
  })

  it('Cursor and Codex editing different files produces no conflict', async () => {
    const session = await createSession('Cursor-Codex No Conflict')

    await prisma.connector.upsert({
      where: { id: 'cursor-hooks' },
      update: {},
      create: { id: 'cursor-hooks', name: 'Cursor Hooks', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'codex-cli' },
      update: {},
      create: { id: 'codex-cli', name: 'Codex CLI', version: '1.0.0', capabilities: {} }
    })

    await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'cursor-sess-1',
        tool: 'edit_file',
        params: { path: 'src/a.ts', content: 'cursor edit' },
        connectorId: 'cursor-hooks',
        connectorVersion: '1.0.0',
        mcpEventId: `cursor-diff-${randSuffix()}`
      }
    })

    await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'codex-1',
        tool: 'edit_file',
        params: { path: 'src/b.ts', patch: 'x' },
        connectorId: 'codex-cli',
        connectorVersion: '1.0.0',
        mcpEventId: `codex-diff-${randSuffix()}`
      }
    })

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(0)
  })

  it('CursorHooksConnector connects and emits events through bridge', async () => {
    const session = await createSession('Cursor Bridge Test')
    const connector = new CursorHooksConnector({
      workingDir: process.cwd(),
      hooksPath: `${process.env.TMPDIR ?? process.env.TMP ?? '/tmp'}/cursor-hooks-e2e-${randSuffix()}.json`,
    })

    const events: import('@meetless/shared/types').NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    await connector.connect()

    // Send a hook event through the bridge
    const http = await import('http')
    const port = connector['bridge'].port
    const secret = connector['secret']

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-meetless-secret': secret,
        },
      })
      req.on('response', (res) => {
        expect(res.statusCode).toBe(200)
        resolve()
      })
      req.on('error', reject)
      req.end(JSON.stringify({
        hook_event_name: 'afterFileEdit',
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        session_id: session.id,
        tool_name: 'Write',
        tool_input: { file_path: 'src/app.ts' },
        tool_output: 'diff content here',
      }))
    })

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].params).toEqual({ path: 'src/app.ts', content: 'diff content here' })

    await connector.disconnect()
  })
})
```

- [ ] **Step 2: Run E2E tests**

Run: `npm test --workspace=@meetless/api -- --run e2e-cursor-hooks`
Expected: All tests PASS (requires Docker Postgres running)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/e2e-cursor-hooks.test.ts
git commit -m "test(cursor-hooks): add E2E test for Cursor → reconciliation pipeline"
```

---

### Task 8: Demo Script

**Files:**
- Create: `apps/api/scripts/demo-cursor-hooks.ts`
- Modify: `apps/api/package.json` (add `demo:cursor` script)

**Interfaces:**
- Consumes: `CursorHooksConnector` from Task 6, existing API from `apps/api/src/app.ts`
- Produces: Runnable demo script

- [ ] **Step 1: Create the demo script**

```typescript
// apps/api/scripts/demo-cursor-hooks.ts
#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { CursorHooksConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

const prisma = new PrismaClient()

async function main() {
  console.log('=== Cursor Hooks Connector Demo ===\n')

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
  const team = await prisma.team.create({ data: { name: 'Cursor Demo Team', slug: `cursor-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_cursor_${Date.now()}`, email: `cursor-demo-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Cursor Demo Workspace' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'Cursor Demo Session' } })
  console.log(`Session created: ${session.id}`)

  // 3. Set up connector + pipeline
  const registry = new InMemoryConnectorRegistry()
  const connector = new CursorHooksConnector({
    workingDir: process.cwd(),
    hooksPath: `${process.env.TMPDIR ?? process.env.TMP ?? '/tmp'}/cursor-hooks-demo.json`,
  })
  registry.register(connector)
  const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })

  await connector.connect()
  console.log(`Connector connected — bridge on port ${connector['bridge'].port}`)
  console.log(`Secret: ${connector['secret']}`)

  // 4. Simulate Cursor editing a file (via bridge)
  console.log('\nAgent A (Cursor) editing src/app.ts ...')
  const http = await import('http')
  const bridgePort = connector['bridge'].port
  const secret = connector['secret']

  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridgePort,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-meetless-secret': secret,
      },
    })
    req.on('response', () => { console.log('Cursor event ingested'); resolve() })
    req.on('error', reject)
    req.end(JSON.stringify({
      hook_event_name: 'afterFileEdit',
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      session_id: session.id,
      tool_name: 'Write',
      tool_input: { file_path: 'src/app.ts' },
      tool_output: 'function main() { return "Cursor version" }',
    }))
  })

  // 5. Simulate Claude editing the SAME file (cross-connector conflict)
  console.log('\nAgent B (Claude) editing src/app.ts ...')
  await pipeline.handleEvent({
    sessionId: session.id,
    agentId: 'claude-1',
    tool: 'edit_file',
    params: { path: 'src/app.ts', content: 'function main() { return "Claude version" }' },
    result: { success: true },
    timestamp: Date.now(),
    connectorId: 'claude-code',
    connectorVersion: '1.0.0',
    mcpEventId: 'claude-demo-1'
  })
  console.log('Claude event ingested')

  // 6. Verify conflicts via DB
  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  // 7. Verify via API
  const resp = await fetch(`${baseUrl}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await resp.json() as Array<{ file: string; agents: string[] }>
  console.log(`\nAPI GET /api/sessions/${session.id}/conflicts returned ${apiConflicts.length} conflict(s)`)

  // 8. Clean up
  await connector.disconnect()
  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Add demo:cursor script to apps/api/package.json**

Add to the `scripts` section:
```json
"demo:cursor": "npx tsx scripts/demo-cursor-hooks.ts"
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build --workspace=@meetless/shared && npm run build --workspace=@meetless/api`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/demo-cursor-hooks.ts apps/api/package.json
git commit -m "feat(cursor-hooks): add demo script for Cursor hooks connector"
```

---

### Task 9: Documentation Update

**Files:**
- Modify: `docs/project-overview.md`

**Interfaces:**
- Consumes: (none)
- Produces: Updated documentation

- [ ] **Step 1: Update project-overview.md**

Add Cursor Hooks connector to the Available Connectors table:

```markdown
| Connector | ID | Tools | Status |
|-----------|----|-------|--------|
| Claude Code | `claude-code` | `edit_file`, `read_file`, `list_files`, `grep`, `todo_write`, `bash` | ✅ |
| Codex CLI | `codex-cli` | `file_patch` → `edit_file`, `shell_exec` → `bash` | ✅ |
| Cursor Hooks | `cursor-hooks` | `edit_file`, `read_file`, `list_files`, `grep`, `bash`, `subagent`, `mcp_tool`, `session_init`, `session_end` | ✅ |
```

Add Cursor demo to Getting Started:

```markdown
# Run Cursor Hooks demo (separate terminal)
npm run demo:cursor --workspace=@meetless/api
```

- [ ] **Step 2: Commit**

```bash
git add docs/project-overview.md
git commit -m "docs: add Cursor Hooks connector to project overview"
```

---

### Task 10: Full Validation

**Files:** (none — verification only)

- [ ] **Step 1: Run all shared package tests**

Run: `npm test --workspace=@meetless/shared -- --run`
Expected: All tests PASS (existing + new cursor-hooks tests)

- [ ] **Step 2: Run all API tests**

Run: `npm test --workspace=@meetless/api -- --run`
Expected: All tests PASS (existing + new e2e-cursor-hooks test)

- [ ] **Step 3: Run lint**

Run: `npm run lint --workspace=@meetless/shared && npm run lint --workspace=@meetless/api`
Expected: Lint passes with no errors

- [ ] **Step 4: Run build**

Run: `npm run build --workspace=@meetless/shared && npm run build --workspace=@meetless/api`
Expected: Build succeeds

- [ ] **Step 5: Verify git status is clean**

Run: `git status`
Expected: No uncommitted changes (all changes committed in prior tasks)

---

## Self-Review Checklist

1. **Spec coverage:** Cursor hooks connector ✅, hook installer ✅, bridge server ✅, event normalization ✅, cross-platform ✅, E2E test ✅, demo ✅, barrel export ✅, documentation ✅. No gaps found.

2. **Placeholder scan:** No TBD/TODO placeholders found. All code blocks contain complete implementations.

3. **Type consistency:** `CursorHookEvent`, `CursorHookPayload`, `NormalizedAgentEvent` types used consistently across all tasks. `normalizeCursorHookEvent` signature matches Task 1 interface and Task 2 test expectations. `BridgeServer` port used by `HookInstaller` (Task 5 updates port after bridge starts). `CursorHooksConnector.id === 'cursor-hooks'` matches DB upserts in E2E test.

4. **Reconciliation engine unchanged:** The plan does NOT modify `apps/api/src/services/reconciliation.ts`. Cursor events use `tool: 'edit_file'` with `params.path` and `params.content`, which the existing engine already handles. No incompatibility discovered.
