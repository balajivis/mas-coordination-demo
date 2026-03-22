#!/usr/bin/env bun
/**
 * Slack Channel — MCP server bridging Slack ↔ Claude Code sessions.
 *
 * When someone @mentions the bot in Slack, it delivers a channel notification
 * into the connected Claude Code session. Claude can reply back to Slack
 * via the reply_slack tool.
 *
 * Architecture:
 *   Slack (Socket Mode) → app_mention event → MCP channel notification → Claude Code
 *   Claude Code → reply_slack tool → Slack chat.postMessage
 *
 * Env vars (from .env in this directory):
 *   SLACK_BOT_TOKEN    — xoxb-... (OAuth & Permissions)
 *   SLACK_APP_TOKEN    — xapp-... (Socket Mode app-level token)
 *   SLACK_SIGNING_SECRET — Basic Information > App Credentials
 *
 * Usage:
 *   claude --dangerously-load-development-channels slack-channel
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { App, type GenericMessageEvent } from '@slack/bolt'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'

// --- Load .env manually (Bun reads .env automatically, but be explicit) ---
const DIR = dirname(new URL(import.meta.url).pathname)
function loadEnv() {
  try {
    const envFile = readFileSync(join(DIR, '.env'), 'utf-8')
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!process.env[key]) process.env[key] = value
    }
  } catch {
    // .env not found — rely on environment
  }
}
loadEnv()

// --- Validate credentials ---
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const APP_TOKEN = process.env.SLACK_APP_TOKEN
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET

if (!BOT_TOKEN || !APP_TOKEN || !SIGNING_SECRET) {
  process.stderr.write(
    'slack-channel: missing env vars. Need SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET\n'
  )
  process.exit(1)
}

// --- Helpers ---
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

// Track recent messages for context
interface SlackMessage {
  channel: string
  channelName?: string
  user: string
  userName?: string
  text: string
  ts: string
  thread_ts?: string
  received_at: string
}

const recentMessages: SlackMessage[] = []
const MAX_RECENT = 50

// Channel name cache
const channelNameCache = new Map<string, string>()
const userNameCache = new Map<string, string>()

// --- MCP Server ---
const mcp = new Server(
  { name: 'slack-channel', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      `You are connected to Slack via a channel MCP server.`,
      ``,
      `## When you receive a <channel> notification from Slack`,
      `The notification contains a Slack message where someone @mentioned the bot.`,
      `1. Read the message content`,
      `2. Use reply_slack to respond in the same channel/thread`,
      ``,
      `## Available tools`,
      `- reply_slack: Send a message back to a Slack channel (use channel + thread_ts from the notification)`,
      `- list_recent_messages: See recent Slack messages received`,
      `- get_channel_info: Look up a Slack channel by name`,
    ].join('\n'),
  },
)

// Deliver a channel notification into the Claude Code session
function deliverNotification(source: string, message: string, meta?: Record<string, unknown>): void {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: message,
      meta: {
        source,
        ts: now(),
        ...meta,
      },
    },
  })
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply_slack',
      description: 'Send a message to a Slack channel. Use the channel ID and thread_ts from the incoming notification to reply in-thread.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Slack channel ID (e.g. C07XXXXXXXX). Provided in the notification meta.',
          },
          text: {
            type: 'string',
            description: 'The message text to send.',
          },
          thread_ts: {
            type: 'string',
            description: 'Optional: thread timestamp to reply in-thread. Use the ts from the notification to keep conversation threaded.',
          },
        },
        required: ['channel', 'text'],
      },
    },
    {
      name: 'list_recent_messages',
      description: 'List recent Slack messages received by this channel server. Returns the last N messages.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of recent messages to return (default 10, max 50).',
          },
        },
      },
    },
    {
      name: 'get_channel_info',
      description: 'Look up a Slack channel by name to get its ID.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Channel name (without #). E.g. "claude-code".',
          },
        },
        required: ['name'],
      },
    },
  ],
}))

// --- Slack Bolt App ---
const slack = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  signingSecret: SIGNING_SECRET,
  socketMode: true,
})

// Resolve channel name (cached)
async function resolveChannelName(channelId: string): Promise<string> {
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId)!
  try {
    const info = await slack.client.conversations.info({ channel: channelId })
    const name = info.channel?.name ?? channelId
    channelNameCache.set(channelId, name)
    return name
  } catch {
    return channelId
  }
}

// Resolve user name (cached)
async function resolveUserName(userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!
  try {
    const info = await slack.client.users.info({ user: userId })
    const name = info.user?.real_name ?? info.user?.name ?? userId
    userNameCache.set(userId, name)
    return name
  } catch {
    return userId
  }
}

// Handle @mentions
slack.event('app_mention', async ({ event }) => {
  const channelName = await resolveChannelName(event.channel)
  const userName = await resolveUserName(event.user)

  // Strip the bot mention from the text
  const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()

  const msg: SlackMessage = {
    channel: event.channel,
    channelName,
    user: event.user,
    userName,
    text: cleanText,
    ts: event.ts,
    thread_ts: event.thread_ts,
    received_at: now(),
  }

  recentMessages.push(msg)
  if (recentMessages.length > MAX_RECENT) recentMessages.shift()

  process.stderr.write(`slack-channel: @mention from ${userName} in #${channelName}: ${cleanText}\n`)

  // Deliver as channel notification to Claude Code
  deliverNotification('slack', `Slack message from ${userName} in #${channelName}:\n\n${cleanText}`, {
    slack_channel: event.channel,
    slack_channel_name: channelName,
    slack_user: event.user,
    slack_user_name: userName,
    slack_ts: event.ts,
    slack_thread_ts: event.thread_ts ?? event.ts,
  })
})

// Handle DMs (optional)
slack.event('message', async ({ event }) => {
  // Only handle DMs (im), skip other message subtypes
  const msg = event as GenericMessageEvent
  if (msg.channel_type !== 'im' || msg.subtype) return

  const userName = await resolveUserName(msg.user!)

  const slackMsg: SlackMessage = {
    channel: msg.channel,
    user: msg.user!,
    userName,
    text: msg.text ?? '',
    ts: msg.ts,
    thread_ts: msg.thread_ts,
    received_at: now(),
  }

  recentMessages.push(slackMsg)
  if (recentMessages.length > MAX_RECENT) recentMessages.shift()

  process.stderr.write(`slack-channel: DM from ${userName}: ${msg.text}\n`)

  deliverNotification('slack-dm', `Slack DM from ${userName}:\n\n${msg.text}`, {
    slack_channel: msg.channel,
    slack_user: msg.user,
    slack_user_name: userName,
    slack_ts: msg.ts,
    slack_thread_ts: msg.thread_ts ?? msg.ts,
  })
})

// --- MCP Tool handlers ---
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'reply_slack': {
        const channel = args.channel as string
        const text = args.text as string
        const thread_ts = args.thread_ts as string | undefined

        const result = await slack.client.chat.postMessage({
          channel,
          text,
          ...(thread_ts ? { thread_ts } : {}),
        })

        return {
          content: [{
            type: 'text',
            text: `Message sent to ${channel}${thread_ts ? ' (in thread)' : ''} — ts: ${result.ts}`,
          }],
        }
      }

      case 'list_recent_messages': {
        const limit = Math.min(Number(args.limit) || 10, MAX_RECENT)
        const messages = recentMessages.slice(-limit)

        if (messages.length === 0) {
          return { content: [{ type: 'text', text: 'No messages received yet.' }] }
        }

        const formatted = messages.map(m =>
          `[${m.received_at}] #${m.channelName ?? m.channel} — ${m.userName ?? m.user}: ${m.text}`
          + (m.thread_ts && m.thread_ts !== m.ts ? ` (thread: ${m.thread_ts})` : '')
        ).join('\n')

        return { content: [{ type: 'text', text: formatted }] }
      }

      case 'get_channel_info': {
        const name = args.name as string

        // List channels and find by name
        const result = await slack.client.conversations.list({
          types: 'public_channel',
          limit: 200,
        })

        const found = result.channels?.find(c => c.name === name)
        if (!found) {
          return {
            content: [{ type: 'text', text: `Channel #${name} not found. Check the name and ensure the bot is invited.` }],
            isError: true,
          }
        }

        return {
          content: [{
            type: 'text',
            text: `#${found.name} — ID: ${found.id}, members: ${found.num_members ?? '?'}, topic: ${found.topic?.value || '(none)'}`,
          }],
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

// --- Start everything ---
// Connect MCP over stdio first
await mcp.connect(new StdioServerTransport())

// Then start Slack in the background
await slack.start()
process.stderr.write(`slack-channel: connected to Slack via Socket Mode\n`)
