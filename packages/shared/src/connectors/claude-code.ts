import childProcess from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
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

interface ToolCallPayload {
  id?: string | number
  tool?: string
  params?: Record<string, unknown>
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
      this.process = childProcess.spawn('claude', ['--mcp'], {
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
    this.buffer = ''
  }

  async sendMCPEvent(event: MCPEvent): Promise<void> {
    if (!this.process) throw new Error('Not connected')
    const msg: MCPMessage = {
      jsonrpc: '2.0',
      id: event.id,
      method: event.type === 'tool_call' ? 'tools/call' : 'resources/read',
      params: event.payload
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
        console.warn('Failed to parse MCP message:', raw)
        return
      }
    } else {
      msg = raw
    }

    if (!msg || msg.method !== 'tools/call' || !msg.params) return

    // Support both standard MCP tool-call params ({ name, arguments }) and
    // enveloped MCPEvent payloads ({ id, type, payload: { tool, params } })
    const p = msg.params as Record<string, unknown>
    const enveloped =
      p.payload && typeof p.payload === 'object' ? (p.payload as ToolCallPayload) : null

    const tool =
      typeof p.name === 'string'
        ? p.name
        : typeof enveloped?.tool === 'string'
          ? enveloped.tool
          : undefined
    if (!tool) return

    const params = (p.arguments ?? enveloped?.params ?? {}) as Record<string, unknown>
    const envelopeId = p.id !== undefined && p.id !== null ? String(p.id) : null
    const innerId =
      enveloped && enveloped.id !== undefined && enveloped.id !== null ? String(enveloped.id) : null
    const mcpEventId = innerId ?? envelopeId ?? String(msg.id)

    const event: NormalizedAgentEvent = {
      sessionId: '', // Will be filled by ingestion pipeline
      agentId: `claude-${this.process?.pid ?? 'unknown'}`,
      tool,
      params,
      result: msg.result,
      timestamp: Date.now(),
      connectorId: this.id,
      connectorVersion: this.version,
      mcpEventId,
      rawMCPEvent: msg
    }
    this.emitEvent(event)
  }
}
