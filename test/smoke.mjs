/**
 * Node smoke test for the Host half.
 *
 * It imports the real module with a stub Cordis context, drives the two handler
 * routes through fake HTTP pairs, and checks the junction farm on disk. Node 20+
 * (`node test/smoke.mjs`).
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const workDir = mkdtempSync(join(tmpdir(), 'dsocw-'))
const folderA = join(workDir, 'alpha')
const folderB = join(workDir, 'beta')
mkdirSync(folderA)
mkdirSync(folderB)

process.env.DSH_OPEN_CODE_WORKSPACE_ROOT = join(workDir, 'farm')

const workspaceFile = join(workDir, 'demo.code-workspace')
writeFileSync(
  workspaceFile,
  `{
    // VS Code allows comments and trailing commas.
    "folders": [
      { "name": "Alpha", "path": "./alpha" },
      { "path": "./beta" },
      { "path": "./gone" },
    ],
    "settings": { "window.title": "demo" }
  }`,
)

const routes = []
const ctx = {
  effect(run) {
    run()
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

const { apply } = await import(`file://${join(packageRoot, 'index.js')}`)
apply(ctx)

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

check('two exact handler routes', routes.length === 2 && routes.every((route) => route.kind === 'exact' && route.handler))

function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : chunk.toString()
    },
  }
}

async function call(suffix, method, body) {
  const route = routes.find((entry) => entry.path.endsWith(`/${suffix}`))
  if (!route) throw new Error(`no route for ${suffix}`)
  const response = fakeResponse()
  await route.handler(fakeRequest(method, route.path, body), response)
  let payload = null
  try {
    payload = JSON.parse(response.body)
  } catch {
    payload = null
  }
  return { status: response.status, payload, raw: response.body }
}

const first = await call('multiroot', 'POST', JSON.stringify({ path: workspaceFile }))
check('workspace file opens', first.status === 200 && first.payload?.kind === 'multiroot', first.raw)
check('two folders linked', first.payload?.folders?.length === 2, JSON.stringify(first.payload?.folders))
check(
  'missing folder skipped',
  first.payload?.folders?.every((folder) => folder.name !== 'gone') ?? false,
)
const farmPath = first.payload?.path
check('farm directory exists', typeof farmPath === 'string' && statSync(farmPath).isDirectory())

// Rewriting the file opens a farm with the new folder set instead of reusing the
// old links; the first farm stays on disk untouched.
writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: './beta' }] }))
const second = await call('multiroot', 'POST', JSON.stringify({ path: workspaceFile }))
check('rewrite succeeds', second.status === 200, second.raw)
check('rewrite gets its own farm', second.payload?.path !== farmPath, second.payload?.path)
check('old farm keeps its links', readdirSync(farmPath).length === 2, readdirSync(farmPath).join(','))
check('new farm has one link', readdirSync(second.payload?.path).length === 1, readdirSync(second.payload?.path).join(','))

const missing = await call('multiroot', 'POST', JSON.stringify({ path: join(workDir, 'nope.code-workspace') }))
check('missing file is 404', missing.status === 404, missing.raw)

const relative = await call('multiroot', 'POST', JSON.stringify({ path: './demo.code-workspace' }))
check('relative path is 400', relative.status === 400 && relative.payload?.error === 'invalid-path', relative.raw)

const notWorkspace = join(workDir, 'notes.txt')
writeFileSync(notWorkspace, 'hello')
const wrongKind = await call('multiroot', 'POST', JSON.stringify({ path: notWorkspace }))
check('non-workspace file is 400', wrongKind.status === 400 && wrongKind.payload?.error === 'not-a-workspace-file', wrongKind.raw)

const wrongMethod = await call('multiroot', 'GET')
check('GET is 405', wrongMethod.status === 405, wrongMethod.raw)

const emptyBody = await call('multiroot', 'POST', '')
check('empty body is 400', emptyBody.status === 400, emptyBody.raw)

rmSync(workDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nhost smoke test OK')
