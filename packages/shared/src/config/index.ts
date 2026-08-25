import { envSchema, type Env } from './schema.js'
import 'dotenv/config'

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config: Env = parsed.data
export default config