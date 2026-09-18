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

export const CURSOR_PERMISSION_HOOKS = [
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeReadFile',
] as const

export type CursorPermissionHook = (typeof CURSOR_PERMISSION_HOOKS)[number]

export function isCursorPermissionHook(name: string): boolean {
  return (CURSOR_PERMISSION_HOOKS as readonly string[]).includes(name)
}

export interface CursorDecisionConfig {
  baseUrl?: string
  apiToken?: string
  timeoutMs?: number
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
  status?: string
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
