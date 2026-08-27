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
  private buffer = ''
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

  private handleMCPMessage(raw: MCPMessage | string): void {
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
