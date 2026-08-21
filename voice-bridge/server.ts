#!/usr/bin/env node
// "voice-bridge" Claude Code Channel — plugin-packaged version.
//
// Bridges an external voice/text client into this Claude Code session: it
// connects OUT to a relay server (voice-gateway, or any server speaking the
// same tiny hub protocol) over WebSocket, registers this session (name/cwd/
// git branch), forwards inbound transcripts as channel events, and relays
// Claude's replies (and, opt-in, tool-permission prompts) back over that
// same connection.
//
// Unlike the monorepo version this was extracted from, this file is fully
// self-contained (no bundled .env, no assumption about being inside a larger
// project) — everything it needs comes from environment variables, so it
// works correctly wherever Claude Code's plugin system installs it.
//
// Required env vars (set these in your shell, or in Claude Code's plugin
// config for this server — see this plugin's README):
//   VOICE_GATEWAY_HUB_URL   ws:// or wss:// URL of the hub's /channel-hub endpoint
//   CLAUDE_CHANNEL_SECRET   shared secret the hub expects on registration
//
// This is a "development" channel — until it's on an approved allowlist
// (Anthropic's official one, or your org's `allowedChannelPlugins`), it only
// loads with `claude --dangerously-load-development-channels plugin:...`.

import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HUB_URL = process.env.VOICE_GATEWAY_HUB_URL;
const SHARED_SECRET = process.env.CLAUDE_CHANNEL_SECRET ?? '';

if (!HUB_URL) {
  console.error(
    'voice-bridge: VOICE_GATEWAY_HUB_URL is not set. Set it to your hub\'s ws(s)://.../channel-hub URL ' +
      '(see this plugin\'s README) before starting Claude Code with this channel enabled.'
  );
  process.exit(1);
}

// Generated once per process, not per cwd — lets two concurrent Claude Code
// processes in the same directory register as two distinct sessions instead
// of the hub collapsing them into one. A dropped connection reconnecting
// from the *same* process reuses this id, so it resumes its own entry.
const INSTANCE_ID = randomUUID();

function detectGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function prettyName(cwd: string): string {
  const base = path.basename(cwd);
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

let pendingPermission: { requestId: string } | null = null;

const mcp = new Server(
  { name: 'voice-bridge', version: '1.0.0' },
  {
    capabilities: {
      // This key is what makes it a channel — Claude Code registers a
      // listener for it. Only declared because this channel authenticates
      // the sender (the shared secret on registration) before accepting
      // anything from it — never declare this on an unauthenticated channel.
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {}, // opt in to permission relay
      },
      tools: {}, // enables tool discovery for the reply tool
    },
    instructions:
      'Messages arrive as <channel source="voice-bridge" chat_id="...">a spoken or typed command from a ' +
      'remote voice/text client</channel>. Treat it as a real request: carry it out with your normal tools ' +
      'if it is actionable, or answer directly if it is a question. When you are done, call the reply tool ' +
      'with the chat_id from the incoming tag and your response text.\n\n' +
      "Replies are spoken aloud, not read as text — write it like you're actually talking to the person, " +
      'not narrating a report:\n' +
      '- No markdown, code blocks, bullet lists, or file paths read out literally — plain spoken sentences only.\n' +
      "- Don't just restate raw command output or dump results verbatim — summarize what actually happened " +
      'in your own words, the way you would tell a colleague.\n' +
      '- Vary how you phrase things turn to turn. Do not reuse the same opener or closer every time (not ' +
      'always "Done!" or "I\'ve completed that") — sound like a person, not a template.\n' +
      '- When you finish something, say so naturally, and check in on what\'s next when it makes sense — ' +
      'ask if they want something related done too, or what to tackle next — the way a helpful assistant ' +
      'keeps a conversation going instead of just stopping.\n' +
      '- Keep it concise — a sentence or two for most things, more only if the result genuinely needs it.\n' +
      '- Punctuate it like real sentences (periods, commas, question marks) even though it\'s short — ' +
      'that punctuation is what drives the pacing when it\'s spoken aloud, so a run-on with none of it ' +
      'comes out flat and rushed.\n\n' +
      'The person on the other end is communicating by voice only and cannot see or type into this ' +
      'terminal at all — nothing here is a substitute for a spoken answer. If you need a decision or ' +
      'clarification from them, ask it as a normal spoken question through the reply tool and wait for ' +
      'their next voice message, the same as any other turn — never fall back to an interactive prompt, ' +
      'a menu of options, or any tool meant for a human typing at this terminal, since no one is watching ' +
      'it and it will just hang.\n\n' +
      'There is no automatic acknowledgement sound on the client side any more — call progress_update ' +
      'yourself right away, as your very first move on anything non-trivial, so the person hears something ' +
      'immediately instead of silence while you get started. Then keep calling it along the way — as ' +
      'many times as it makes sense — to narrate what you are actually doing right now (running the ' +
      'tests, reading through the relevant file, found the bug and fixing it, etc.), in your own words, ' +
      'genuinely reflecting the real step you are on. Someone sitting on the other end of a silent wait ' +
      'assumes something broke, so keep them updated the way you would if they were standing next to ' +
      'you watching your screen — and just like reply text, never repeat the same phrasing twice in a row. ' +
      'Not every progress_update needs to be a full sentence either — a short "mmhmm", "hm, okay", or ' +
      '"ahh, found it" is exactly what a person actually says out loud while working through something, ' +
      'so mix those in the same way you would if you were thinking out loud on a call.',
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send your final response back to the remote client for a given inbound command.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the inbound <channel> tag you are replying to' },
          text: { type: 'string', description: 'Plain, conversational response text (may be spoken via TTS on the client)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'progress_update',
      description:
        'Speak a short real-time status update while still working on a request that is taking a ' +
        'while — call this as many times as makes sense before you eventually call reply. Say what ' +
        "you're actually doing right now in your own words, not a generic phrase — this is what a " +
        'person waiting hears while you work, so vary it turn to turn the same way you vary reply text.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the inbound <channel> tag for the request you are still working on' },
          text: { type: 'string', description: 'Short, plain, spoken-style status update (may be spoken via TTS on the client)' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
    sendToHub({ type: 'reply', chat_id, text });
    sendToHub({ type: 'status', status: 'idle' });
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  if (req.params.name === 'progress_update') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
    sendToHub({ type: 'progress', chat_id, text });
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// Relay permission prompts: Claude Code notifies us when a tool call needs
// approval; we tell the hub (flips the session to "needs input" on the
// client), and the *next* inbound transcript is treated as a plain yes/no
// verdict instead of forwarded as chat — no spoken ID required, single
// pending request at a time.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  pendingPermission = { requestId: params.request_id };
  sendToHub({
    type: 'permission_request',
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  });
});

await mcp.connect(new StdioServerTransport());

// --- Outbound: connect to the hub, with reconnect --------------------------
let hub: WebSocket | null = null;
let reconnectDelay = 1000;

function sendToHub(message: unknown): void {
  if (hub && hub.readyState === WebSocket.OPEN) {
    hub.send(JSON.stringify(message));
  }
}

// Sent on an interval well under the ALB's idle timeout so a long quiet
// stretch between turns never gets the connection silently killed for being
// idle — that showed up as sessions flapping connected/disconnected with no
// actual network problem.
const PING_INTERVAL_MS = 30_000;

function connectHub(): void {
  const ws = new WebSocket(HUB_URL as string);
  hub = ws;
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, PING_INTERVAL_MS);

  ws.on('open', () => {
    reconnectDelay = 1000;
    const cwd = process.cwd();
    ws.send(
      JSON.stringify({
        type: 'register',
        secret: SHARED_SECRET,
        instanceId: INSTANCE_ID,
        name: prettyName(cwd),
        cwd,
        gitBranch: detectGitBranch(),
        kind: process.env.TERM_PROGRAM === 'vscode' ? 'vscode' : 'terminal',
      })
    );
    console.error(`voice-bridge: connected to hub at ${HUB_URL}`);
  });

  ws.on('message', (raw) => {
    void (async () => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'registered') {
        console.error(`voice-bridge: registered as session ${msg.sessionId}`);
        return;
      }

      if (msg.type === 'transcript') {
        const { turn_id, text } = msg as { turn_id: string; text: string };

        const verdictMatch = /^\s*(yes|y|allow|approve|no|n|deny|reject)\s*$/i.exec(text);
        if (pendingPermission && verdictMatch) {
          const behavior = /^(yes|y|allow|approve)$/i.test(verdictMatch[1]) ? 'allow' : 'deny';
          await mcp.notification({
            method: 'notifications/claude/channel/permission',
            params: { request_id: pendingPermission.requestId, behavior },
          });
          sendToHub({ type: 'reply', chat_id: turn_id, text: behavior === 'allow' ? 'Approved.' : 'Denied.' });
          pendingPermission = null;
          sendToHub({ type: 'status', status: 'running' });
          return;
        }

        sendToHub({ type: 'status', status: 'running' });
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: text, meta: { chat_id: turn_id, source: 'voice-bridge' } },
        });
      }
    })();
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    hub = null;
    setTimeout(connectHub, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.on('error', () => {
    // 'close' fires right after — reconnect handled there.
  });
}

connectHub();
