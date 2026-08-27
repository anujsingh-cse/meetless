# Cursor Hook Normalizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a normalizer that maps Cursor hook payloads to NormalizedAgentEvent format.

**Architecture:** Implement a normalizer function that takes CursorHookEvent objects and converts them to NormalizedAgentEvent format, mapping tool names and extracting parameters appropriately.

**Tech Stack:** TypeScript, vitest for testing

**Spec:** `packages/shared/src/connectors/cursor-hooks/types.ts` (existing types)

## Global Constraints

- Use TypeScript with strict type checking
- Follow existing codebase patterns
- Use vitest for testing
- Tests should be in `__tests__/` directories
- Use `.js` extensions in imports for ESM compatibility

---

### Task 2: Create Cursor Hook Normalizer

**Files:**
- Create: `packages/shared/src/connectors/cursor-hooks/normalizer.ts`
- Create: `packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts`

**Interfaces:**
- Consumes: `CursorHookEvent` from `./types.js`, `NormalizedAgentEvent` from `../../types/index.js`
- Produces: `normalizeCursorHookEvent()` function

- [ ] **Step 1: Create directory structure**

Create the test directory:
```bash
New-Item -ItemType Directory -Force -Path "packages/shared/src/connectors/cursor-hooks/__tests__"
```

- [ ] **Step 2: Create normalizer.ts**

Create `packages/shared/src/connectors/cursor-hooks/normalizer.ts` with the following implementation:

```typescript
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

- [ ] **Step 3: Create test file**

Create `packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts` with the following tests:

```typescript
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

- [ ] **Step 4: Run tests**

Run the tests to verify implementation:
```bash
npm test --workspace=@meetless/shared -- --run normalizer
```

- [ ] **Step 5: Run build**

Run the build to verify TypeScript compilation:
```bash
npm run build --workspace=@meetless/shared
```

- [ ] **Step 6: Commit changes**

Commit the implementation:
```bash
git add packages/shared/src/connectors/cursor-hooks/normalizer.ts packages/shared/src/connectors/cursor-hooks/__tests__/normalizer.test.ts
git commit -m "feat(cursor-hooks): add Cursor hook event normalizer with tests"
```

- [ ] **Step 7: Self-review**

Review the implementation for:
- Correct type usage
- Proper error handling
- Test coverage
- Code style consistency
- Documentation completeness