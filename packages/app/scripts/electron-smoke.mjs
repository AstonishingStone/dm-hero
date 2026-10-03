// Smoke test for the PACKAGED Electron app (electron-builder --dir output).
// Launches the real executable, waits for the bundled Nitro server and does a
// DB write + read through the API. This catches what a build alone can't:
// native modules (better-sqlite3, bindings) failing to load in the package.
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER_URL = 'http://127.0.0.1:3456'
const TIMEOUT_MS = 120_000
const WINDOW_READY = '[Electron] Window ready to show'
const WINDOW_FAILED = '[Electron] Failed to load:'
const distDir = join(import.meta.dirname, '..', 'dist-electron')

function findExecutable() {
  if (process.platform === 'win32') return join(distDir, 'win-unpacked', 'DM Hero.exe')
  if (process.platform === 'linux') return join(distDir, 'linux-unpacked', 'dm-hero')
  const macDir = readdirSync(distDir).find(d => d.startsWith('mac'))
  return join(distDir, macDir ?? 'mac', 'DM Hero.app', 'Contents', 'MacOS', 'DM Hero')
}

const executable = findExecutable()
if (!existsSync(executable)) {
  console.error(`❌ Executable not found: ${executable}`)
  process.exit(1)
}

// Another server on the port (e.g. a running DM Hero) would make the checks
// below test the wrong process
try {
  await fetch(SERVER_URL)
  console.error(`❌ Port of ${SERVER_URL} is already in use - stop the other process first`)
  process.exit(1)
}
catch { /* port free */ }

// Fresh profile so the test never depends on (or touches) existing data
const userDataDir = mkdtempSync(join(tmpdir(), 'dm-hero-smoke-'))
const args = [`--user-data-dir=${userDataDir}`]
if (process.platform === 'linux') args.push('--no-sandbox', '--ozone-platform=x11')

console.log(`▶ Launching ${executable}`)
console.log(`  userData: ${userDataDir}`)
const child = spawn(executable, args, { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } })

let output = ''
child.stdout.on('data', (d) => {
  output += d
})
child.stderr.on('data', (d) => {
  output += d
})
// Set on ANY exit - a crash by signal (e.g. SIGSEGV) has code null
let exitReason = null
child.on('exit', (code, signal) => {
  exitReason = signal ? `signal ${signal}` : `code ${code}`
})

function stop() {
  if (exitReason) return
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' })
    }
    catch { /* already gone */ }
  }
  else {
    child.kill('SIGKILL')
  }
}

function fail(message) {
  console.error(`❌ ${message}`)
  console.error('----- app output -----')
  console.error(output || '(no output)')
  stop()
  process.exit(1)
}

async function waitForServer() {
  const start = Date.now()
  while (Date.now() - start < TIMEOUT_MS) {
    if (exitReason) fail(`App exited early with ${exitReason}`)
    let res
    try {
      res = await fetch(`${SERVER_URL}/api/campaigns`)
    }
    catch { /* not up yet */ }
    if (res?.ok) return Date.now() - start
    // Server is up but broken (e.g. native module failed to load) - no point waiting
    if (res && res.status >= 500) fail(`Server error HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    await new Promise(r => setTimeout(r, 1000))
  }
  fail(`Server did not respond within ${TIMEOUT_MS / 1000}s`)
}

const startupMs = await waitForServer()
console.log(`✅ Server up after ${(startupMs / 1000).toFixed(1)}s`)

// DB write + read proves better-sqlite3 works inside the package
const name = `Smoke ${Date.now()}`
const created = await fetch(`${SERVER_URL}/api/campaigns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, description: 'electron smoke test' }),
})
if (!created.ok) fail(`Creating a campaign failed: HTTP ${created.status} ${await created.text()}`)

const campaigns = await (await fetch(`${SERVER_URL}/api/campaigns`)).json()
if (!Array.isArray(campaigns) || !campaigns.some(c => c.name === name)) {
  fail(`Created campaign not found in list: ${JSON.stringify(campaigns).slice(0, 500)}`)
}
console.log('✅ Database write + read OK')

// The window itself must load the app (reported by electron/main.js)
async function waitForWindow() {
  const start = Date.now()
  while (Date.now() - start < TIMEOUT_MS) {
    if (exitReason) fail(`App exited before the window loaded with ${exitReason}`)
    if (output.includes(WINDOW_FAILED)) fail('Window failed to load the app')
    if (output.includes(WINDOW_READY)) return
    await new Promise(r => setTimeout(r, 500))
  }
  fail(`Window not ready within ${TIMEOUT_MS / 1000}s`)
}

await waitForWindow()
console.log('✅ Window loaded the app')

await new Promise(r => setTimeout(r, 5000))
if (exitReason) fail(`App exited after startup with ${exitReason}`)
if (output.includes(WINDOW_FAILED)) fail('Window failed to load the app')
console.log('✅ App still running 5s after window load')

stop()
console.log('✅ Electron smoke test passed')
process.exit(0)
