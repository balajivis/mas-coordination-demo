# Slack Channel MCP Server — Setup Guide

Two-way Slack integration for Claude Code Channels. Takes under 5 minutes.

---

## Step 1: Create the Slack App

1. Go to **https://api.slack.com/apps**
2. Click **"Create New App" > "From scratch"**
3. Name: `claude-channel-bot` (or whatever you like)
4. Pick your workspace
5. Click **Create App**

## Step 2: Add Bot Token Scopes

Go to **OAuth & Permissions > Scopes > Bot Token Scopes** and add:

### Minimum (channel @mentions + reply)

| Scope | Why |
|-------|-----|
| `app_mentions:read` | Receive `@bot` mentions in channels |
| `chat:write` | Send messages back to channels |
| `channels:read` | Resolve channel names |

### Optional (DM support + extras)

| Scope | Why |
|-------|-----|
| `chat:write.public` | Post to channels the bot hasn't been invited to |
| `channels:history` | Read message history in public channels |
| `im:read` | Resolve DM conversation IDs |
| `im:write` | Open DM conversations |
| `im:history` | Read DM messages |
| `users:read` | Resolve user names/profiles |
| `reactions:write` | Add emoji reactions as status indicators |

## Step 3: Enable Socket Mode

Socket Mode = no public URL needed. Works on localhost.

1. Go to **Settings > Socket Mode**
2. Toggle **ON**
3. Generate an **App-Level Token**:
   - Name: `socket-token`
   - Scope: `connections:write`
   - Click **Generate**
4. Copy the token (starts with `xapp-`)

## Step 4: Subscribe to Events

1. Go to **Event Subscriptions**
2. Toggle **ON**
3. Under **Subscribe to bot events**, add:
   - `app_mention` — fires when someone `@mentions` the bot
   - `message.im` — fires when someone DMs the bot (optional)

No Request URL needed — Socket Mode handles delivery over WebSocket.

## Step 5: Install and Get Bot Token

1. Go to **Install App**
2. Click **Install to Workspace** and authorize
3. Go back to **OAuth & Permissions**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

## Step 6: Invite the Bot

In Slack, in your demo channel:

```
/invite @claude-channel-bot
```

---

## Three Values You Need

```bash
SLACK_BOT_TOKEN=xoxb-...          # OAuth & Permissions page
SLACK_APP_TOKEN=xapp-...          # Socket Mode page (app-level token)
SLACK_SIGNING_SECRET=...          # Basic Information > App Credentials
```

Put these in a `.env` file in this directory.

---

## Verify It Works (standalone, before wiring to Channel MCP)

```bash
npm install @slack/bolt
```

```typescript
import { App } from "@slack/bolt";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.event("app_mention", async ({ event, say }) => {
  await say({
    text: `Got it, <@${event.user}>. Working on it...`,
    thread_ts: event.ts,
  });
});

(async () => {
  await app.start();
  console.log("Slack bot running via Socket Mode");
})();
```

If the bot responds to @mentions, your credentials are correct.

---

## Wiring to Channel MCP Server

Once Slack works standalone, the channel MCP server wraps it:

1. Slack Bolt receives `app_mention` event
2. Channel server emits `notifications/claude/channel` with the message content
3. Claude Code session receives it as `<channel source="slack">...</channel>`
4. Claude calls the `reply` tool to send a response
5. Channel server calls `chat.postMessage` back to Slack

The `blackboard-channel.ts` in this directory handles the MCP side.
The Slack-specific adapter needs the three env vars above.

---

## Socket Mode vs HTTP Events

| Concern | Socket Mode | HTTP Events |
|---------|-------------|-------------|
| Local development | Use this | Needs ngrok or public URL |
| Workshop demo | Use this | Overkill |
| Production | Fine for single server | Better for load-balanced |
| Slack Marketplace | Not eligible | Required |

**For this demo: Socket Mode is correct.**
