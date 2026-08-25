import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/meetless'
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
process.env.NODE_ENV = 'test'
process.env.PORT = '3000'
process.env.HOST = '0.0.0.0'
process.env.LOG_LEVEL = 'info'