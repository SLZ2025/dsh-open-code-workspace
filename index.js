/**
 * Host half of dsh-open-code-workspace.
 *
 * DSH's directory picker on this class of install is the native backend, so the
 * browser cannot browse the filesystem and cannot turn a `.code-workspace` file
 * into anything. This Host half does the two things the browser cannot:
 *
 *   1. `pick` — asks the OS for one `.code-workspace` file through the real
 *      shell dialog (Windows FileDialog, macOS `choose file`, zenity/kdialog).
 *   2. `multiroot` — reads that file's `folders` and materializes them as ONE
 *      directory whose entries are junctions/symlinks to the real folders, so a
 *      single Workspace root shows every folder side by side, the way VS Code
 *      opens a multi-root workspace.
 *
 * Both routes are plain `handler` routes: resource routes only answer GET/HEAD
 * over HTTP, and the client has to POST a path. Both are also gated by
 * `ctx.connection.authorizeIndex`, the same browser-session check DSH's own
 * pages use, so a Web page that is not the DSH UI cannot drive them.
 */
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const inject = ['webServer', 'connection']

const ROUTE_PREFIX = '/dsh-open-code-workspace/'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const FARM_ROOT = process.env.DSH_OPEN_CODE_WORKSPACE_ROOT ?? join(DSH_HOME, 'multiroot')
const MAX_REQUEST_BYTES = 8_192
const MAX_PATH_LENGTH = 4_096
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/** One dialog at a time: a second click while a dialog is open answers 409. */
let picking = false

export function apply(ctx) {
  const route = (suffix, respond) => {
    const path = ROUTE_PREFIX + suffix
    ctx.effect(() => {
      try {
        return ctx.webServer.register({
          kind: 'exact',
          path,
          handler: (request, response) => {
            // Both routes act on the user's machine (native dialog, links on
            // disk), so they accept only the page DSH itself authenticated:
            // `authorizeIndex` validates the browser session cookie and owns the
            // 401/redirect response when it refuses.
            if (!ctx.connection.authorizeIndex(request, response)) return
            return serve(respond, request, response)
          },
        })
      } catch (error) {
        console.error(`[dsh-open-code-workspace] could not register ${path}: ${describe(error)}`)
        throw error
      }
    }, `dsh-open-code-workspace: ${suffix}`)
  }
  route('pick', () => respondPick())
  route('multiroot', (request) => respondMultiroot(request))
}

/**
 * Bridge one plain handler onto the raw HTTP pair a handler route receives:
 * collect the body, hand it to the handler as a `Request`, then write the
 * handler's `Response` back out.
 */
async function serve(respond, request, response) {
  try {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', ...JSON_HEADERS })
      response.end(JSON.stringify({ error: 'method-not-allowed' }))
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        response.writeHead(413, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'request-too-large' }))
        return
      }
      chunks.push(chunk)
    }
    const body = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8')
    const wrapped = new Request(new URL(request.url ?? '/', 'http://127.0.0.1'), {
      method: 'POST',
      headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
      body,
    })
    const result = await respond(wrapped)
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, JSON_HEADERS)
    response.end(JSON.stringify({ error: 'internal', message: describe(error) }))
  }
}

/**
 * Ask the OS for one `.code-workspace` file. Each platform shells out to its own
 * native dialog, so the Host process never runs a message loop of its own.
 */
async function respondPick() {
  if (picking) return json({ error: 'picker-busy' }, 409)
  picking = true
  try {
    const picked = await openFileDialog()
    return json({ path: picked === null ? null : resolve(picked) })
  } catch (error) {
    return json({ error: 'picker-unavailable', message: describe(error) }, 501)
  } finally {
    picking = false
  }
}

function openFileDialog() {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = 'Open workspace file'",
      "$dialog.Filter = 'Code workspace (*.code-workspace)|*.code-workspace|All files (*.*)|*.*'",
      '$dialog.CheckFileExists = $true',
      '$dialog.Multiselect = $false',
      'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }',
      '$owner.Dispose()',
    ].join('; ')
    return runDialog('powershell.exe', ['-NoProfile', '-Sta', '-WindowStyle', 'Hidden', '-Command', script])
  }
  if (process.platform === 'darwin') {
    return runDialog('osascript', [
      '-e',
      'POSIX path of (choose file with prompt "Open a .code-workspace file")',
    ])
  }
  return runDialog('zenity', [
    '--file-selection',
    '--title=Open workspace file',
    '--file-filter=Code workspace (*.code-workspace) | *.code-workspace',
    '--file-filter=All files | *',
  ]).catch(() =>
    runDialog('kdialog', [
      '--getopenfilename',
      '.',
      '*.code-workspace',
      '--title',
      'Open workspace file',
    ]),
  )
}

/** Run one dialog command; stdout carries the chosen absolute path (empty = cancelled). */
function runDialog(command, args) {
  return new Promise((settle, fail) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      fail(error)
      return
    }
    const chunks = []
    child.stdout?.on('data', (chunk) => chunks.push(chunk))
    child.stderr?.on('data', () => {})
    child.on('error', (error) => fail(error))
    child.on('close', () => {
      const picked = Buffer.concat(chunks).toString('utf8').trim()
      settle(picked === '' ? null : picked)
    })
  })
}

/**
 * Open a `.code-workspace` as ONE Workspace the way VS Code does: aggregate its
 * folders under a single directory of junctions (Windows) or symlinks (POSIX),
 * so one Session root shows every folder side by side.
 */
async function respondMultiroot(request) {
  const payload = await readJson(request)
  const raw = payload === null ? undefined : payload.path
  const requested = typeof raw === 'string' ? raw.trim() : ''
  if (requested === '' || requested.length > MAX_PATH_LENGTH || !isAbsolute(requested)) {
    return json({ error: 'invalid-path' }, 400)
  }
  const target = resolve(requested)
  let stats
  try {
    stats = statSync(target)
  } catch {
    return json({ error: 'not-found', path: target }, 404)
  }
  if (!stats.isFile() || !/\.code-workspace$/i.test(target)) {
    return json({ error: 'not-a-workspace-file', path: target }, 400)
  }
  let folders
  try {
    folders = readWorkspaceFile(target)
  } catch (error) {
    return json({ error: 'unreadable-file', path: target, message: describe(error) }, 400)
  }
  const usable = folders.filter((folder) => folder.exists)
  if (usable.length === 0) return json({ error: 'empty-workspace', path: target }, 400)
  try {
    return json(ensureFarm(target, usable))
  } catch (error) {
    return json({ error: 'farm-failed', path: target, message: describe(error) }, 500)
  }
}

function ensureFarm(file, folders) {
  const title = basename(file).replace(/\.code-workspace$/i, '')
  // The folder list is part of the farm identity: editing the file opens a fresh
  // farm instead of silently reusing a directory with the old set of links.
  const fingerprint = createHash('sha1')
    .update(folders.map((folder) => folder.path.toLowerCase()).join('\n'))
    .digest('hex')
    .slice(0, 8)
  const farmPath = join(FARM_ROOT, `${sanitizeSegment(title)}-${fingerprint}`)
  mkdirSync(farmPath, { recursive: true })

  const desired = new Map()
  for (const folder of folders) {
    const stem = sanitizeSegment(folder.name || basename(folder.path))
    let name = stem
    let suffix = 2
    while (desired.has(name.toLowerCase())) {
      name = `${stem} (${suffix})`
      suffix += 1
    }
    desired.set(name.toLowerCase(), { name, folder })
  }

  const linked = []
  const failed = []
  for (const { name, folder } of desired.values()) {
    const linkPath = join(farmPath, name)
    if (!existsSync(linkPath)) {
      try {
        symlinkSync(folder.path, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        failed.push({ name, path: folder.path, message: describe(error) })
        continue
      }
    }
    linked.push({ name, path: folder.path, link: linkPath })
  }

  const payload = { kind: 'multiroot', path: farmPath, title, folders: linked }
  return failed.length === 0 ? payload : { ...payload, failed }
}

function sanitizeSegment(value) {
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return cleaned === '' ? 'workspace' : cleaned.slice(0, 80)
}

function readWorkspaceFile(filePath) {
  const parsed = JSON.parse(stripJsonc(readFileSync(filePath, 'utf8')))
  const folders = Array.isArray(parsed.folders) ? parsed.folders : []
  const base = dirname(filePath)
  const resolved = []
  for (const folder of folders) {
    const declared = typeof folder === 'string' ? folder : folder?.path
    if (typeof declared !== 'string' || declared.trim() === '') continue
    const absolute = resolve(base, declared.trim())
    let exists = false
    try {
      exists = statSync(absolute).isDirectory()
    } catch {
      exists = false
    }
    resolved.push({
      name: (typeof folder === 'object' && typeof folder?.name === 'string' && folder.name) || basename(absolute),
      path: absolute,
      exists,
    })
  }
  return resolved
}

/** VS Code allows comments and trailing commas in these files. */
function stripJsonc(text) {
  let output = ''
  let inString = false
  let escaped = false
  let line = false
  let block = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (line) {
      if (character === '\n') {
        line = false
        output += character
      }
      continue
    }
    if (block) {
      if (character === '*' && next === '/') {
        block = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += character
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      output += character
      continue
    }
    if (character === '/' && next === '/') {
      line = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      block = true
      index += 1
      continue
    }
    output += character
  }
  return output.replace(/,\s*([}\]])/g, '$1')
}

async function readJson(request) {
  try {
    const text = await request.text()
    if (text.length > MAX_REQUEST_BYTES) return null
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}
