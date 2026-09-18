import http from 'http'

const args = process.argv.slice(2)
function getArg(name: string) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

const secret = getArg('secret')
const port = getArg('port')
const eventName = getArg('event') ?? ''

const PERMISSION_HOOKS = new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile'])
const isPermissionHook = PERMISSION_HOOKS.has(eventName)

// Cursor permission hooks must receive a valid verdict JSON on stdout. Fail-open:
// any error/timeout/missing verdict ⇒ allow. Non-permission hooks stay observe-only.
function printVerdict(verdict: 'allow' | 'deny', reason?: string) {
  if (verdict === 'deny') {
    const message = reason || 'Blocked by rule'
    process.stdout.write(JSON.stringify({ continue: true, permission: 'deny', user_message: message, agent_message: message }) + '\n')
  } else {
    process.stdout.write(JSON.stringify({ continue: true, permission: 'allow' }) + '\n')
  }
}

let body = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => { body += chunk })
process.stdin.on('end', () => {
  if (!secret || !port) {
    if (isPermissionHook) printVerdict('allow') // fail-open
    process.exit(1)
  }

  const req = http.request({
    hostname: '127.0.0.1',
    port: Number(port),
    path: '/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-meetless-secret': secret,
    },
  })

  // Adapter-enforced timeout, independent of the harness default.
  const timeout = setTimeout(() => {
    req.destroy(new Error('bridge timeout'))
  }, 3000)

  let resBody = ''
  req.on('response', (res) => {
    res.setEncoding('utf-8')
    res.on('data', (chunk) => { resBody += chunk })
    res.on('end', () => {
      clearTimeout(timeout)
      if (res.statusCode !== 200) {
        if (isPermissionHook) printVerdict('allow') // fail-open
        process.exit(res.statusCode === 200 ? 0 : 1)
      }
      if (isPermissionHook) {
        try {
          const parsed = JSON.parse(resBody) as { verdict?: string; reason?: string }
          if (parsed.verdict === 'deny') {
            printVerdict('deny', parsed.reason)
          } else {
            printVerdict('allow')
          }
        } catch {
          printVerdict('allow') // invalid JSON ⇒ fail-open
        }
      }
      process.exit(0)
    })
  })

  req.on('error', () => {
    clearTimeout(timeout)
    if (isPermissionHook) printVerdict('allow') // fail-open
    process.exit(1)
  })

  req.end(body)
})