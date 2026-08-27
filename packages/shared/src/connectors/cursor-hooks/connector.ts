import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
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

const BRIDGE_CLIENT_SCRIPT = fileURLToPath(new URL('./bridge-client.mjs', import.meta.url))

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
      bridgePort: 0,
    })
  }

  async connect(): Promise<void> {
    await this.bridge.start()

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
