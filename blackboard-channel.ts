#!/usr/bin/env bun
/**
 * DEPRECATED — This is the original monolithic implementation.
 * It has been replaced by the split architecture:
 *   - blackboard-server.ts  (shared singleton, owns YAML, broadcasts)
 *   - blackboard-shim.ts    (thin per-agent MCP proxy)
 *
 * See README.md for the current architecture. This file is kept for reference only.
 *
 * Original description:
 * Each agent session runs a copy on a unique port (env: BLACKBOARD_PORT).
 * Tools let agents read/write the blackboard. An HTTP endpoint receives
 * notifications from other agents or the dashboard. The dashboard is embedded
 * and served at GET /.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
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
        blackboard: { project: 'mas-coordination-demo', description: 'Shared state' },
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
  // Atomic rename
  const { renameSync } = require('fs')
  renameSync(tmp, LIVE)
}

function appendLog(data: any, entry: string): void {
  if (!Array.isArray(data.log)) data.log = []
  data.log.push({ ts: now(), entry })
  // Keep last 200 entries
  if (data.log.length > 200) data.log = data.log.slice(-200)
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

// --- MCP Server ---
const mcp = new Server(
  { name: 'blackboard-channel', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      `You are connected to a MAS blackboard coordination channel.`,
      ``,
      `## On startup`,
      `1. Use read_blackboard to see current state`,
      `2. Use write_to_blackboard to register yourself under agents: with your name, role, and status: "active"`,
      ``,
      `## When you receive a <channel> notification`,
      `1. Use read_blackboard to see what changed`,
      `2. Check directives: for any tasks assigned to you`,
      `3. Do the work`,
      `4. Use write_to_blackboard to update your status and log results`,
      ``,
      `## Rules`,
      `- Only write to your own section under agents:`,
      `- Write results under your agent key`,
      `- Add log entries for significant actions`,
      `- Use notify_agent to ping other agents when you produce something they need`,
      ``,
      `Dashboard: http://localhost:${PORT}`,
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_blackboard',
      description: 'Read the current blackboard state (YAML). Returns the full shared state including all agents, directives, and log.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description: 'Optional: return only this top-level key (e.g. "agents", "directives", "log"). Omit for full state.',
          },
        },
      },
    },
    {
      name: 'write_to_blackboard',
      description: 'Write to a section of the blackboard. Use path to target a specific key (e.g. "agents.my_agent" or "directives"). Value is the data to write.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Dot-separated path to the key to write (e.g. "agents.researcher", "directives").',
          },
          value: {
            description: 'The value to set at that path. Can be any JSON-compatible value (object, array, string, etc.).',
          },
          log_entry: {
            type: 'string',
            description: 'Optional log message describing what changed.',
          },
        },
        required: ['path', 'value'],
      },
    },
    {
      name: 'notify_agent',
      description: 'Send a notification to another agent by POSTing to their blackboard-channel port. They will receive a <channel> notification.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'The port number of the target agent\'s blackboard-channel server.',
          },
          message: {
            type: 'string',
            description: 'A short message describing why you\'re notifying them.',
          },
        },
        required: ['port', 'message'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'read_blackboard': {
        const data = readBlackboard()
        const section = args.section as string | undefined
        if (section && section in data) {
          return { content: [{ type: 'text', text: YAML.stringify(data[section]) }] }
        }
        return { content: [{ type: 'text', text: YAML.stringify(data) }] }
      }

      case 'write_to_blackboard': {
        const path = args.path as string
        const value = args.value
        const logEntry = args.log_entry as string | undefined

        const data = readBlackboard()
        const parts = path.split('.')
        let target = data
        for (let i = 0; i < parts.length - 1; i++) {
          if (target[parts[i]] === undefined || target[parts[i]] === null) {
            target[parts[i]] = {}
          }
          target = target[parts[i]]
        }
        target[parts[parts.length - 1]] = value

        if (logEntry) {
          appendLog(data, logEntry)
        }

        writeBlackboard(data)
        broadcastDashboard()

        return { content: [{ type: 'text', text: `wrote to ${path}` }] }
      }

      case 'notify_agent': {
        const port = args.port as number
        const message = args.message as string

        try {
          const resp = await fetch(`http://127.0.0.1:${port}/notify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: `agent@${PORT}`, message }),
          })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          return { content: [{ type: 'text', text: `notified agent on port ${port}` }] }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `failed to notify port ${port}: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          }
        }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

// Connect MCP over stdio
await mcp.connect(new StdioServerTransport())

// Deliver a channel notification into this agent session
function deliverNotification(source: string, message: string): void {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: message,
      meta: {
        source,
        ts: now(),
        blackboard_port: PORT,
      },
    },
  })
}

// --- HTTP + WebSocket server (dashboard + notify endpoint) ---
ensureLive()

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade for live dashboard
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return
      return new Response('upgrade failed', { status: 400 })
    }

    // POST /notify — receives notifications from other agents or the dashboard
    if (url.pathname === '/notify' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { source?: string; message?: string }
          const source = body.source ?? 'unknown'
          const message = body.message ?? 'blackboard updated'
          deliverNotification(source, message)
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // POST /directive — dashboard posts a new directive
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
          broadcastDashboard()
          // Notify this agent session about the new directive
          deliverNotification('dashboard', `New directive: ${body.text}`)
          return new Response(JSON.stringify({ ok: true, id: directive.id }), {
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
        }
      })()
    }

    // GET /state — raw JSON state for polling
    if (url.pathname === '/state') {
      const data = readBlackboard()
      return new Response(JSON.stringify(data), {
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
      // Send current state immediately
      const state = readBlackboard()
      ws.send(JSON.stringify({ type: 'state', data: state }))
    },
    close: (ws) => { wsClients.delete(ws) },
    message: () => {},  // Dashboard is read + directive-post only
  },
})

process.stderr.write(`blackboard-channel: http://localhost:${PORT}\n`)

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

  /* Agent cards */
  .agent-card {
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    padding: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .agent-card:last-child { margin-bottom: 0; }
  .agent-name {
    font-weight: 600;
    color: #10b981;
    font-size: 0.85rem;
  }
  .agent-role {
    color: #71717a;
    font-size: 0.75rem;
  }
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

  /* Directives */
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
  .directive .d-meta {
    color: #52525b;
    font-size: 0.7rem;
    margin-top: 0.25rem;
  }
  .directive .d-assignee {
    color: #10b981;
    font-size: 0.7rem;
  }
  .d-status-pending { border-left: 3px solid #f59e0b; }
  .d-status-in_progress { border-left: 3px solid #3b82f6; }
  .d-status-done { border-left: 3px solid #10b981; }

  /* Log */
  .log-entry {
    font-size: 0.75rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #1c1c1e;
    display: flex;
    gap: 0.75rem;
  }
  .log-entry:last-child { border-bottom: none; }
  .log-ts {
    color: #52525b;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .log-text { color: #a1a1aa; }

  /* Input */
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
  .input-bar input[type="text"]:focus {
    border-color: #10b981;
  }
  .input-bar input[type="text"]::placeholder {
    color: #52525b;
  }
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

  /* Scrollable panels */
  .scroll-inner {
    max-height: 300px;
    overflow-y: auto;
  }
  .scroll-inner::-webkit-scrollbar { width: 4px; }
  .scroll-inner::-webkit-scrollbar-track { background: transparent; }
  .scroll-inner::-webkit-scrollbar-thumb { background: #27272a; border-radius: 2px; }

  body { padding-bottom: 5rem; }

  /* Project header */
  .project-name {
    color: #52525b;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .notify-row {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .notify-row input {
    width: 80px;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 0.5rem;
    padding: 0.35rem 0.5rem;
    color: #e4e4e7;
    font-family: inherit;
    font-size: 0.75rem;
    outline: none;
  }
  .notify-row button {
    background: #27272a;
    color: #a1a1aa;
    border: none;
    border-radius: 0.5rem;
    padding: 0.35rem 0.75rem;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .notify-row button:hover { background: #3f3f46; }
</style>
</head>
<body>

<h1>MAS Blackboard</h1>
<div class="subtitle">channel-based coordination &middot; port <span id="port"></span></div>

<div class="grid">
  <div class="panel">
    <h2>Agents <span class="count" id="agent-count">0</span></h2>
    <div class="scroll-inner" id="agents-list">
      <div class="empty">no agents registered</div>
    </div>
    <div class="notify-row">
      <input type="number" id="notify-port" placeholder="port">
      <button onclick="notifyPort()">notify agent</button>
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

let state = {}

// WebSocket for live updates
const ws = new WebSocket('ws://' + location.host + '/ws')
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'state') {
    state = msg.data
    render(state)
  }
}
ws.onclose = () => {
  setTimeout(() => location.reload(), 2000)
}

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

  if (names.length === 0) {
    el.innerHTML = '<div class="empty">no agents registered</div>'
    return
  }

  el.innerHTML = names.filter(n => agents[n] != null).map(name => {
    const a = agents[name]
    const status = a.status || 'unknown'
    const statusClass = 'status-' + status.replace(/[^a-z]/g, '')
    const role = a.role ? ' &middot; ' + esc(a.role) : ''
    const task = a.task ? '<div style="color:#71717a;font-size:0.75rem;margin-top:0.25rem">' + esc(a.task) + '</div>' : ''
    const registered = a.registered_at ? '<div style="color:#3f3f46;font-size:0.65rem;margin-top:0.15rem">since ' + shortTime(a.registered_at) + '</div>' : ''
    return '<div class="agent-card">'
      + '<span class="agent-name">' + esc(name) + '</span>'
      + '<span class="agent-role">' + role + '</span>'
      + ' <span class="agent-status ' + statusClass + '">' + esc(status) + '</span>'
      + task + registered
      + '</div>'
  }).join('')
}

function renderDirectives(directives) {
  const el = document.getElementById('directives-list')
  document.getElementById('directive-count').textContent = directives.length

  if (directives.length === 0) {
    el.innerHTML = '<div class="empty">no directives</div>'
    return
  }

  el.innerHTML = directives.slice().reverse().map(d => {
    const statusClass = 'd-status-' + (d.status || 'pending')
    const assignee = d.assignee ? '<span class="d-assignee"> &rarr; ' + esc(d.assignee) + '</span>' : ''
    return '<div class="directive ' + statusClass + '">'
      + '<div class="d-text">' + esc(d.text) + assignee + '</div>'
      + '<div class="d-meta">' + shortTime(d.posted_at) + ' &middot; ' + esc(d.status || 'pending') + '</div>'
      + '</div>'
  }).join('')
}

function renderLog(log) {
  const el = document.getElementById('log-list')
  document.getElementById('log-count').textContent = log.length

  if (log.length === 0) {
    el.innerHTML = '<div class="empty">no log entries</div>'
    return
  }

  el.innerHTML = log.slice().reverse().map(l => {
    return '<div class="log-entry">'
      + '<span class="log-ts">' + shortTime(l.ts) + '</span>'
      + '<span class="log-text">' + esc(l.entry) + '</span>'
      + '</div>'
  }).join('')
}

function updateAssigneeOptions(agents) {
  const sel = document.getElementById('assignee-select')
  const current = sel.value
  const names = Object.keys(agents)
  sel.innerHTML = '<option value="">all agents</option>'
    + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('')
  sel.value = current
}

function postDirective() {
  const input = document.getElementById('directive-input')
  const text = input.value.trim()
  if (!text) return
  const assignee = document.getElementById('assignee-select').value
  fetch('/directive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, assignee: assignee || undefined }),
  })
  input.value = ''
}

function notifyPort() {
  const portInput = document.getElementById('notify-port')
  const p = parseInt(portInput.value)
  if (!p) return
  fetch('http://127.0.0.1:' + p + '/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'dashboard', message: 'check blackboard' }),
  }).catch(err => console.error('notify failed:', err))
}

// Enter to post
document.getElementById('directive-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    postDirective()
  }
})

function shortTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return iso }
}

function esc(s) {
  if (typeof s !== 'string') return String(s ?? '')
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
</script>

</body>
</html>`
