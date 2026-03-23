# Slack Channel MCP Server — Setup Guide

Two-way Slack integration for Claude Code Channels via `slack-channel.ts`.

---

## Part 1: Create the Slack App

1. Go to **https://api.slack.com/apps** → **Create New App** → **From scratch**
2. Name it (e.g. `Blackboard MAI`) and pick your workspace
3. **OAuth & Permissions** (left sidebar) → scroll to **Bot Token Scopes** → add:
   - `app_mentions:read`
   - `chat:write`
   - `channels:read`
4. **Settings > Socket Mode** → toggle **ON** → generate an App-Level Token (name: `socket-token`, scope: `connections:write`) → copy the `xapp-` token
5. **Event Subscriptions** → toggle **ON** → **Subscribe to bot events** → add `app_mention`
6. **Install App** → **Install to Workspace** → authorize → go back to **OAuth & Permissions** → copy the `xoxb-` Bot Token
7. **Basic Information > App Credentials** → copy the **Signing Secret**

## Part 2: Configure Credentials

Create `.env` in this directory:

```bash
SLACK_BOT_TOKEN=xoxb-...          # from step 6
SLACK_APP_TOKEN=xapp-...          # from step 4
SLACK_SIGNING_SECRET=...          # from step 7
```

## Part 3: Install Dependencies

```bash
bun add @slack/bolt @slack/web-api
```

## Part 4: MCP Server Registration

The Slack channel is already configured in `.mcp.json` — no manual registration needed. Just make sure you have the `.env` file with credentials from the steps above.

## Part 5: Launch and Test

Exit the session, then relaunch with the channel enabled:

```bash
claude --dangerously-load-development-channels server:slack-channel
```

### Invite the bot to your channel

In Slack:

```
/invite @Blackboard MAI
```

(Use whatever name you gave the app in step 1.)

### Test outbound (Claude Code → Slack)

Tell Claude:

```
Use get_channel_info to find "claude-code", then reply_slack "Hello from Claude Code!" to it.
```

### Test inbound (Slack → Claude Code)

In Slack, type in your channel:

```
@Blackboard MAI What time is it?
```

The session receives a `<channel>` notification and Claude replies back via `reply_slack`.

---

## MCP Tools Reference

| Tool | Direction | Description |
|------|-----------|-------------|
| `reply_slack` | outbound | Post a message to a Slack channel/thread |
| `get_channel_info` | read | Look up a channel by name to get its ID |
| `list_recent_messages` | read | See recent messages received by the server |

## Running Both Channels (Slack + Blackboard)

```bash
claude --dangerously-load-development-channels server:blackboard-channel server:slack-channel
```

## How It Works

```
Slack @mention → Socket Mode → slack-channel.ts → MCP channel notification → Claude Code session
Claude Code    → reply_slack tool → slack-channel.ts → chat.postMessage → Slack channel
```
