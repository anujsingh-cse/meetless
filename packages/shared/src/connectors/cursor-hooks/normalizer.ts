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