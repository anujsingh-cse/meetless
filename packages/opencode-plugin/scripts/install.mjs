import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../dist')
const targetRoot = path.join(os.homedir(), '.config', 'opencode', 'plugins')

fs.mkdirSync(targetRoot, { recursive: true })
const files = ['index.js', 'types.js', 'normalizer.js', 'emitter.js', 'config.js', 'plugin.js']
const written = []
for (const name of files) {
  const src = path.join(dist, name)
  if (fs.existsSync(src)) {
    const dest = path.join(targetRoot, `meetless-${name}`)
    fs.copyFileSync(src, dest)
    written.push(dest)
  }
}
console.log(`[opencode-plugin] copied ${written.length} file(s) to ${targetRoot}`)