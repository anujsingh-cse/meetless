import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '../src/connectors/cursor-hooks/bridge-client.mjs')
const dest = path.resolve(here, '../dist/connectors/cursor-hooks/bridge-client.mjs')

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.copyFileSync(src, dest)
