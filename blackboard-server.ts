#!/usr/bin/env bun
/**
 * Blackboard Server — shared singleton for multi-agent coordination.
 *
 * This is the true blackboard: one process, one YAML file, multiple observers.
 * Agents connect via thin MCP shims that register callback ports.
 * On any write, the server broadcasts to ALL registered agents.
 *
 * Run independently:  BLACKBOARD_PORT=8790 bun blackboard-server.ts
 *
 * Architecture:
 *   blackboard-live.yaml ← this server owns the file
 *   POST /register       ← shims register their callback port
 *   POST /unregister     ← shims deregister on shutdown
 *   POST /read           ← shims read state via HTTP
 *   POST /write          ← shims write state via HTTP (triggers broadcast)
 *   POST /directive      ← dashboard posts directives (triggers broadcast)
 *   GET  /state          ← raw JSON state
 *   GET  /               ← dashboard UI
 *   WS   /ws             ← live dashboard updates
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'fs'
import { join, dirname, basename } from 'path'
import YAML from 'yaml'
import type { ServerWebSocket } from 'bun'

// --- Config ---
const PORT = Number(process.env.BLACKBOARD_PORT ?? 8790)
const DIR = process.env.BLACKBOARD_DIR ?? dirname(new URL(import.meta.url).pathname)
const TEMPLATE = join(DIR, 'blackboard.yaml')
const LIVE = join(DIR, 'blackboard-live.yaml')

// --- Helpers ---
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function ensureLive(): void {
  if (!existsSync(LIVE)) {
    if (!existsSync(TEMPLATE)) {
      writeFileSync(LIVE, YAML.stringify({
        blackboard: { project: basename(DIR), description: 'Shared state' },
        agents: {},
        directives: [],
        log: [],
      }))
    } else {
      copyFileSync(TEMPLATE, LIVE)
    }
  }
}

function readBlackboard(): any {
  ensureLive()
  return YAML.parse(readFileSync(LIVE, 'utf-8')) ?? {}
}

function writeBlackboard(data: any): void {
  const tmp = LIVE + '.tmp'
  writeFileSync(tmp, YAML.stringify(data))
  renameSync(tmp, LIVE)
}

function appendLog(data: any, entry: string): void {
  if (!Array.isArray(data.log)) data.log = []
  data.log.push({ ts: now(), entry })
  if (data.log.length > 200) data.log = data.log.slice(-200)
}

// --- Agent registry: callback_port → agent_name ---
const agentCallbacks = new Map<number, string>()

async function broadcastToAgents(source: string, message: string): Promise<void> {
  const promises: Promise<void>[] = []
  for (const [callbackPort, agentName] of agentCallbacks) {
    promises.push(
      fetch(`http://127.0.0.1:${callbackPort}/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, message }),
      })
        .then(r => {
          if (!r.ok) console.error(`notify ${agentName}@${callbackPort}: HTTP ${r.status}`)
        })
        .catch(err => {
          console.error(`notify ${agentName}@${callbackPort}: ${err.message}`)
          // Remove dead agents
          agentCallbacks.delete(callbackPort)
        })
    )
  }
  await Promise.allSettled(promises)
}

// --- WebSocket clients for dashboard live updates ---
const wsClients = new Set<ServerWebSocket<unknown>>()

function broadcastDashboard(): void {
  const state = readBlackboard()
  const msg = JSON.stringify({ type: 'state', data: state })
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

// Broadcast to both dashboard and agents
async function broadcastAll(source: string, message: string): Promise<void> {
  broadcastDashboard()
  await broadcastToAgents(source, message)
}

// --- HTTP + WebSocket server ---
ensureLive()

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return
      return new Response('upgrade failed', { status: 400 })
    }

    // POST /register — agent shim registers its callback port
    if (url.pathname === '/register' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { agent: string; callback_port: number }
          agentCallbacks.set(body.callback_port, body.agent)
          console.log(`registered: ${body.agent} @ callback port ${body.callback_port}`)
          return new Response(JSON.stringify({ ok: true, agents: agentCallbacks.size }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // POST /unregister — agent shim deregisters
    if (url.pathname === '/unregister' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { callback_port: number }
          const name = agentCallbacks.get(body.callback_port)
          agentCallbacks.delete(body.callback_port)
          console.log(`unregistered: ${name ?? 'unknown'} @ callback port ${body.callback_port}`)
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // POST /read — shim reads blackboard state
    if (url.pathname === '/read' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { section?: string }
          const data = readBlackboard()
          if (body.section && body.section in data) {
            return new Response(JSON.stringify({ data: data[body.section] }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({ data }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // POST /write — shim writes to blackboard (triggers broadcast)
    if (url.pathname === '/write' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { path: string; value: any; log_entry?: string; source?: string }
          const data = readBlackboard()

          const parts = body.path.split('.')
          let target = data
          for (let i = 0; i < parts.length - 1; i++) {
            if (target[parts[i]] === undefined || target[parts[i]] === null) {
              target[parts[i]] = {}
            }
            target = target[parts[i]]
          }
          target[parts[parts.length - 1]] = body.value

          if (body.log_entry) {
            appendLog(data, body.log_entry)
          }

          writeBlackboard(data)
          await broadcastAll(body.source ?? 'agent', `write to ${body.path}`)

          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // POST /directive — dashboard posts a new directive (triggers broadcast)
    if (url.pathname === '/directive' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { text: string; assignee?: string }
          const data = readBlackboard()
          if (!Array.isArray(data.directives)) data.directives = []
          const directive: any = {
            id: `d${Date.now()}`,
            text: body.text,
            posted_at: now(),
            status: 'pending',
          }
          if (body.assignee) directive.assignee = body.assignee
          data.directives.push(directive)
          appendLog(data, `directive posted: ${body.text}`)
          writeBlackboard(data)
          await broadcastAll('dashboard', `New directive: ${body.text}`)

          return new Response(JSON.stringify({ ok: true, id: directive.id }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // GET /state — raw JSON state
    if (url.pathname === '/state') {
      const data = readBlackboard()
      return new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      })
    }

    // GET /agents — registered agent callbacks (for debugging)
    if (url.pathname === '/agents') {
      const agents: Record<string, number> = {}
      for (const [port, name] of agentCallbacks) agents[name] = port
      return new Response(JSON.stringify(agents), {
        headers: { 'content-type': 'application/json' },
      })
    }

    // GET / — dashboard
    if (url.pathname === '/') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('404', { status: 404 })
  },
  websocket: {
    open: (ws) => {
      wsClients.add(ws)
      const state = readBlackboard()
      ws.send(JSON.stringify({ type: 'state', data: state }))
    },
    close: (ws) => { wsClients.delete(ws) },
    message: () => {},
  },
})

console.log(`blackboard-server: http://localhost:${PORT}`)
console.log(`  dashboard: http://localhost:${PORT}`)
console.log(`  agents will register callback ports via POST /register`)

// --- Embedded Dashboard HTML ---
const DASHBOARD_HTML = /*html*/`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAS Blackboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    background: #09090b;
    color: #e4e4e7;
    min-height: 100vh;
    padding: 1.5rem;
  }

  h1 {
    font-size: 1.25rem;
    color: #10b981;
    margin-bottom: 0.25rem;
  }
  .subtitle {
    font-size: 0.75rem;
    color: #71717a;
    margin-bottom: 1.5rem;
  }
  .subtitle span { color: #10b981; }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 0.75rem;
    padding: 1rem;
    overflow: hidden;
  }
  .panel h2 {
    font-size: 0.85rem;
    color: #a1a1aa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .panel h2 .count {
    background: #27272a;
    color: #71717a;
    font-size: 0.7rem;
    padding: 0.1em 0.5em;
    border-radius: 9999px;
  }

  .agent-card {
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    padding: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .agent-card:last-child { margin-bottom: 0; }
  .agent-name { font-weight: 600; color: #10b981; font-size: 0.85rem; }
  .agent-role { color: #71717a; font-size: 0.75rem; }
  .agent-status {
    display: inline-block;
    font-size: 0.7rem;
    padding: 0.1em 0.5em;
    border-radius: 9999px;
    margin-top: 0.25rem;
  }
  .status-active { background: #064e3b; color: #6ee7b7; }
  .status-idle { background: #1c1917; color: #a8a29e; }
  .status-working { background: #422006; color: #fbbf24; }
  .status-done { background: #14532d; color: #4ade80; }
  .status-failed { background: #450a0a; color: #f87171; }
  .status-planned { background: #1e1b4b; color: #a5b4fc; }

  .directive {
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
  }
  .directive:last-child { margin-bottom: 0; }
  .directive .d-text { color: #e4e4e7; }
  .directive .d-meta { color: #52525b; font-size: 0.7rem; margin-top: 0.25rem; }
  .directive .d-assignee { color: #10b981; font-size: 0.7rem; }
  .d-status-pending { border-left: 3px solid #f59e0b; }
  .d-status-in_progress { border-left: 3px solid #3b82f6; }
  .d-status-done { border-left: 3px solid #10b981; }

  .log-entry {
    font-size: 0.75rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #1c1c1e;
    display: flex;
    gap: 0.75rem;
  }
  .log-entry:last-child { border-bottom: none; }
  .log-ts { color: #52525b; white-space: nowrap; flex-shrink: 0; }
  .log-text { color: #a1a1aa; }

  .input-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #18181b;
    border-top: 1px solid #27272a;
    padding: 0.75rem 1.5rem;
    display: flex;
    gap: 0.5rem;
  }
  .input-bar input[type="text"] {
    flex: 1;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    color: #e4e4e7;
    font-family: inherit;
    font-size: 0.85rem;
    outline: none;
  }
  .input-bar input[type="text"]:focus { border-color: #10b981; }
  .input-bar input[type="text"]::placeholder { color: #52525b; }
  .input-bar select {
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    padding: 0.5rem;
    color: #a1a1aa;
    font-family: inherit;
    font-size: 0.8rem;
    outline: none;
  }
  .input-bar button {
    background: #10b981;
    color: #09090b;
    border: none;
    border-radius: 0.5rem;
    padding: 0.5rem 1rem;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .input-bar button:hover { background: #34d399; }

  .empty {
    color: #3f3f46;
    font-size: 0.8rem;
    font-style: italic;
    padding: 1rem 0;
    text-align: center;
  }

  .full-width { grid-column: 1 / -1; }

  .scroll-inner { max-height: 300px; overflow-y: auto; }
  .scroll-inner::-webkit-scrollbar { width: 4px; }
  .scroll-inner::-webkit-scrollbar-track { background: transparent; }
  .scroll-inner::-webkit-scrollbar-thumb { background: #27272a; border-radius: 2px; }

  body { padding-bottom: 5rem; }
</style>
</head>
<body>

<h1>MAS Blackboard</h1>
<div class="subtitle">shared server &middot; port <span id="port"></span></div>

<div class="grid">
  <div class="panel">
    <h2>Agents <span class="count" id="agent-count">0</span></h2>
    <div class="scroll-inner" id="agents-list">
      <div class="empty">no agents registered</div>
    </div>
  </div>

  <div class="panel">
    <h2>Directives <span class="count" id="directive-count">0</span></h2>
    <div class="scroll-inner" id="directives-list">
      <div class="empty">no directives</div>
    </div>
  </div>

  <div class="panel full-width">
    <h2>Log <span class="count" id="log-count">0</span></h2>
    <div class="scroll-inner" id="log-list" style="max-height: 200px;">
      <div class="empty">no log entries</div>
    </div>
  </div>
</div>

<div class="input-bar">
  <input type="text" id="directive-input" placeholder="Post a directive..." autocomplete="off">
  <select id="assignee-select">
    <option value="">all agents</option>
  </select>
  <button onclick="postDirective()">post</button>
</div>

<script>
const port = location.port || '8790'
document.getElementById('port').textContent = port

const ws = new WebSocket('ws://' + location.host + '/ws')
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'state') render(msg.data)
}
ws.onclose = () => { setTimeout(() => location.reload(), 2000) }

function render(data) {
  renderAgents(data.agents || {})
  renderDirectives(data.directives || [])
  renderLog(data.log || [])
  updateAssigneeOptions(data.agents || {})
}

function renderAgents(agents) {
  const el = document.getElementById('agents-list')
  const names = Object.keys(agents)
  document.getElementById('agent-count').textContent = names.length
  if (names.length === 0) { el.innerHTML = '<div class="empty">no agents registered</div>'; return }
  el.innerHTML = names.map(name => {
    const a = agents[name]
    const status = a.status || 'unknown'
    const statusClass = 'status-' + status.replace(/[^a-z]/g, '')
    const role = a.role ? ' &middot; ' + esc(a.role) : ''
    const task = a.task ? '<div style="color:#71717a;font-size:0.75rem;margin-top:0.25rem">' + esc(a.task) + '</div>' : ''
    const registered = a.registered_at ? '<div style="color:#3f3f46;font-size:0.65rem;margin-top:0.15rem">since ' + shortTime(a.registered_at) + '</div>' : ''
    return '<div class="agent-card"><span class="agent-name">' + esc(name) + '</span><span class="agent-role">' + role + '</span> <span class="agent-status ' + statusClass + '">' + esc(status) + '</span>' + task + registered + '</div>'
  }).join('')
}

function renderDirectives(directives) {
  const el = document.getElementById('directives-list')
  document.getElementById('directive-count').textContent = directives.length
  if (directives.length === 0) { el.innerHTML = '<div class="empty">no directives</div>'; return }
  el.innerHTML = directives.slice().reverse().map(d => {
    const statusClass = 'd-status-' + (d.status || 'pending')
    const assignee = d.assignee ? '<span class="d-assignee"> &rarr; ' + esc(d.assignee) + '</span>' : ''
    return '<div class="directive ' + statusClass + '"><div class="d-text">' + esc(d.text) + assignee + '</div><div class="d-meta">' + shortTime(d.posted_at) + ' &middot; ' + esc(d.status || 'pending') + '</div></div>'
  }).join('')
}

function renderLog(log) {
  const el = document.getElementById('log-list')
  document.getElementById('log-count').textContent = log.length
  if (log.length === 0) { el.innerHTML = '<div class="empty">no log entries</div>'; return }
  el.innerHTML = log.slice().reverse().map(l =>
    '<div class="log-entry"><span class="log-ts">' + shortTime(l.ts) + '</span><span class="log-text">' + esc(l.entry) + '</span></div>'
  ).join('')
}

function updateAssigneeOptions(agents) {
  const sel = document.getElementById('assignee-select')
  const cur = sel.value
  const names = Object.keys(agents)
  sel.innerHTML = '<option value="">all agents</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('')
  sel.value = cur
}

function postDirective() {
  const input = document.getElementById('directive-input')
  const text = input.value.trim()
  if (!text) return
  const assignee = document.getElementById('assignee-select').value
  fetch('/directive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, assignee: assignee || undefined }) })
  input.value = ''
}

document.getElementById('directive-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postDirective() }
})

function shortTime(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return iso }
}

function esc(s) {
  if (typeof s !== 'string') return String(s ?? '')
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
</script>
</body>
</html>`
