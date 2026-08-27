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
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('bash')
    expect(result!.params).toEqual({ command: 'npm test' })
    expect(result!.connectorId).toBe('cursor-hooks')
    expect(result!.sessionId).toBe('sess-1')
    expect(result!.agentId).toContain('cursor-')
  })

  it('maps preToolUse Edit to edit_file', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.ts', content: 'edited content' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('edit_file')
    expect(result!.params).toEqual({ path: 'src/app.ts', content: 'edited content' })
  })

  it('maps preToolUse Glob to list_files', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Glob',
      toolInput: { pattern: '*.ts' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('list_files')
    expect(result!.params).toEqual({ pattern: '*.ts' })
  })

  it('maps preToolUse Write to edit_file', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Write',
      toolInput: { file_path: 'src/app.ts', content: 'new content' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('edit_file')
    expect(result!.params).toEqual({ path: 'src/app.ts', content: 'new content' })
  })

  it('maps preToolUse Read to read_file', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Read',
      toolInput: { file_path: 'src/app.ts' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('read_file')
    expect(result!.params).toEqual({ path: 'src/app.ts' })
  })

  it('maps preToolUse Grep to grep', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Grep',
      toolInput: { pattern: 'TODO' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('grep')
    expect(result!.params).toEqual({ pattern: 'TODO' })
  })

  it('maps preToolUse Task to subagent', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'Task',
      toolInput: { description: 'investigate bug' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('subagent')
    expect(result!.params).toEqual({ description: 'investigate bug' })
  })

  it('maps preToolUse MCP:* to mcp_tool', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'preToolUse',
      toolName: 'MCP:github',
      toolInput: { action: 'create_issue' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('mcp_tool')
    expect(result!.params).toEqual({ name: 'github', action: 'create_issue' })
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
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('edit_file')
    expect(result!.params).toEqual({ path: 'src/app.ts', content: 'diff content' })
  })

  it('maps beforeShellExecution to bash', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'beforeShellExecution',
      toolInput: { command: 'git status' },
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('bash')
    expect(result!.params).toEqual({ command: 'git status' })
  })

  it('maps afterShellExecution to bash with output', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'afterShellExecution',
      toolInput: { command: 'git status' },
      toolOutput: 'On branch main',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('bash')
    expect(result!.params).toEqual({ command: 'git status', output: 'On branch main' })
  })

  it('maps sessionStart to session_init', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'sessionStart',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('session_init')
    expect(result!.params).toEqual({})
  })

  it('maps stop to session_end with status', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'stop',
      status: 'completed',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('session_end')
    expect(result!.params).toEqual({ status: 'completed' })
  })

  it('maps sessionEnd to session_end', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'sessionEnd',
      status: 'completed',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('session_end')
    expect(result!.params).toEqual({ status: 'completed' })
  })

  it('maps subagentStop to subagent with stop action', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'subagentStop',
      subagentId: 'sub-1',
      subagentName: 'investigator',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('subagent')
    expect(result!.params).toEqual({ action: 'stop', subagentId: 'sub-1', subagentName: 'investigator' })
  })

  it('maps subagentStart to subagent with start action', () => {
    const event: CursorHookEvent = {
      ...base,
      hookEventName: 'subagentStart',
      subagentId: 'sub-1',
      subagentName: 'investigator',
    }
    const result = normalizeCursorHookEvent(event, 'cursor-hooks', '1.0.0')
    expect(result).not.toBeNull()
    expect(result!.tool).toBe('subagent')
    expect(result!.params).toEqual({ action: 'start', subagentId: 'sub-1', subagentName: 'investigator' })
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