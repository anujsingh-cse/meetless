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
