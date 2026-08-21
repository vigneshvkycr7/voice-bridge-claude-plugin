# voice-bridge

A Claude Code **Channel** plugin — bridges a remote voice/text client (a
phone app, a webhook, whatever you build) into a live Claude Code session.
Your session keeps running locally; this just relays messages in and replies
out over a WebSocket connection to a relay server you run — a hub that
accepts a `register` message (name/cwd/gitBranch/instanceId/secret) and
forwards `{"type":"transcript","turn_id":...,"text":...}` frames to this
channel, which replies with `{"type":"reply",...}` / `{"type":"status",...}`.
Point `VOICE_GATEWAY_HUB_URL` at any server that speaks this protocol.

## Status: experimental

Claude Code's Channels feature is in **research preview**. Until this plugin
is on an approved allowlist, every session that uses it needs to opt in
explicitly with `--dangerously-load-development-channels`. There are three
ways to get past that flag — pick whichever fits:

1. **Just testing locally** — keep using the flag (see below). No approval
   needed, works today.
2. **Your own organization (Team/Enterprise plan)** — ask your admin to add
   this plugin to the org's managed `allowedChannelPlugins` setting:
   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "voice-bridge-marketplace", "plugin": "voice-bridge" }
     ]
   }
   ```
3. **Anthropic's official marketplace** — requires reaching out to your
   Anthropic partner contact for review; out of scope for casual use.

## Install

From any Claude Code session:
```
/plugin marketplace add <path-or-git-url-to-this-repo>
/plugin install voice-bridge@voice-bridge-marketplace
```
(While developing/testing, adding by local path — e.g. the absolute path to
this repo on your machine — works fine; no git host required until you want
to share it with someone else.)

Then, in the project directory you want to expose as a session, install this
plugin's dependencies once:
```
cd <path-to-installed-plugin>   # wherever Claude Code put it after install
npm install
```

## Configure

Set these two environment variables before starting Claude Code (in your
shell profile, or however you manage env vars):

| Variable | Required | Meaning |
|---|---|---|
| `VOICE_GATEWAY_HUB_URL` | yes | `ws://` or `wss://` URL of your hub's `/channel-hub` endpoint |
| `CLAUDE_CHANNEL_SECRET` | recommended | Shared secret your hub expects on registration — without it, anyone who can reach your hub's `/channel-hub` endpoint can register as a session |

## Run

```
claude --dangerously-load-development-channels plugin:voice-bridge@voice-bridge-marketplace
```

Accept the "New MCP server found" consent prompt. You should see
`voice-bridge: connected to hub at ...` and `voice-bridge: registered as
session ...` on stderr, and the session should show up wherever your hub
surfaces its registry (e.g. the Agent Companion mobile app's Projects
screen).

## Security notes

- This channel declares the `claude/channel/permission` capability, meaning
  it can relay tool-approval prompts to whoever's on the other end of your
  hub. Only point `VOICE_GATEWAY_HUB_URL` at a hub you trust.
- Always set `CLAUDE_CHANNEL_SECRET` outside of local-only testing — the hub
  should reject registrations that don't present it.
- Every inbound transcript is treated as a real, actionable instruction to
  Claude Code with full tool access. Don't point this at a hub you don't
  control, and don't share your hub URL/secret publicly.
