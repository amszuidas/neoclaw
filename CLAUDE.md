# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun start            # Start daemon (self-daemonizes to background, logs to ~/.neoclaw/logs/neoclaw.log)
bun onboard          # Generate ~/.neoclaw/config.json config template
bun run dev          # Run with --watch (auto-restart on file changes)
bun run --bun tsc --noEmit  # Type-check without emitting
```

## Architecture

Gateway pattern. `Dispatcher` (`dispatcher.ts`) routes messages from **Gateways** (I/O adapters) to **Agents** (AI backends).

```
Gateway.start(dispatcher.handle)
  → InboundMessage + ReplyFn + StreamHandler → Dispatcher → Agent.stream() → AgentStreamEvent*
                                                                            ↓
                                                             streamHandler(stream) → Gateway renders
```

**Message flow:**
1. Gateway receives a raw platform event, parses it into `InboundMessage`, creates a `reply` closure and a `streamHandler` closure with protocol context bound
2. Gateway calls `dispatcher.handle(msg, reply, streamHandler)`
3. Dispatcher acquires a per-conversation `SerialQueue` lock to prevent race conditions
4. Checks for slash commands (`/clear`, `/restart`, `/status`, `/help`) — always use non-streaming `reply()`
5. If `streamHandler` is provided and agent has `stream()`, uses streaming path; otherwise falls back to `agent.run()` + `reply()`
6. Gateway's `streamHandler` renders content progressively as events arrive

**Key interfaces** (in `*/types.ts`):
- `Agent`: `run()`, `stream?()`, `healthCheck()`, `clearConversation()`, `dispose()` — AI backend
- `Gateway`: `start(handler)`, `stop()`, `send()` — messaging platform adapter
- `ReplyFn`: `(response: RunResponse) => Promise<void>` — for slash commands and non-streaming fallback
- `StreamHandler`: `(stream: AsyncIterable<AgentStreamEvent>) => Promise<void>` — for progressive rendering
- `MessageHandler`: `(msg, reply, streamHandler?) => Promise<void>` — called by Gateway for each message
- `AgentStreamEvent`: `{ type: 'thinking_delta', text }` | `{ type: 'text_delta', text }` | `{ type: 'done', response: RunResponse }`
- `InboundMessage`: `id`, `text`, `chatId`, `threadRootId?`, `authorId`, `authorName?`, `gatewayKind`, `attachments?: Attachment[]`, `meta?`
- `RunResponse`: `text`, `thinking?`, `sessionId?`, `costUsd?`, `inputTokens?`, `outputTokens?`, `elapsedMs?`, `model?`
- `ToolDefinition`: `name`, `description`, `parameters` (JSON Schema), `handler` — for custom tool registration

**Agents**: `ClaudeCodeAgent` uses Claude Code CLI via long-running subprocess with bidirectional JSONL streaming. Maintains one subprocess per `conversationId` (pooled, reaped after 10 min idle). After idle reap, session IDs are persisted in memory so the next request **resumes** the same Claude session (`--resume <sessionId>`). Each conversation runs in its own workspace directory `~/.neoclaw/workspaces/<conversationId>` (`:` replaced with `_`); the directory is created on first use. Supports custom tool registration via `registerTool(ToolDefinition)` — tool calls are intercepted from the JSONL stream and dispatched to registered handlers. Default model: `claude-sonnet-4-6`.

The `stream()` method on `ClaudeCodeAgent` yields `AgentStreamEvent`s: `thinking_delta` and `text_delta` are emitted for each JSONL `content_block_delta`; a final `done` event carries the full `RunResponse` (including stats).

**Gateways**: `FeishuGateway` (Feishu/Lark WebSocket). Handles:
- Reaction emoji lifecycle (`OneSecond` emoji added on receive, removed after reply)
- Reply threading (replies are sent as thread replies to the original message)
- Error reporting back to the user — all transparent to the Dispatcher
- **Streaming responses** via Feishu Card JSON 2.0 (cardkit API): card created lazily on first delta, updated progressively via `cardkit.v1.cardElement.content`, closed with `cardkit.v1.card.settings`. `print_strategy: 'delay'` gives typewriter effect on the client side
- **Thinking panel**: inserted dynamically via `insertThinkingPanel()` only when a `thinking_delta` arrives (not pre-created); collapsed automatically on `done`
- Non-streaming responses (slash commands, proactive sends) use Feishu Card JSON 1.0-style cards with optional collapsible Thinking panel, markdown body, stats note footer
- Media attachment download: images, files, audio, video, stickers are downloaded and passed as `Attachment[]` in `InboundMessage.attachments`; a `<media:type>` placeholder is appended to the message text
- Quoted/parent message fetching: when a message quotes another (`parent_id`), the quoted text is prepended as `[Replying to: "..."]`
- In group chats, the sender's display name is prepended to the message text for context
- `groupAutoReply`: chats listed in `feishu.groupAutoReply` receive replies without requiring an @mention

**Feishu sender** (`gateway/feishu/sender.ts`): Two card formats:
1. **Non-streaming** (JSON 1.0-style): `buildCard()` → `sendCard()` / `sendMarkdown()`
2. **Streaming** (JSON 2.0, cardkit): `buildStreamingCard()` → `createCardEntity()` → `sendCardByRef()` → `updateCardText()` / `insertThinkingPanel()` / `patchCardElement()` / `appendCardElements()` → `closeCardStreaming()`
   - Element IDs tracked in `STREAM_EL` constant (`thinking_panel`, `thinking_md`, `thinking_hr`, `main_md`, `stats_hr`, `stats_note`)
   - Stats footer uses `markdown` tag (JSON 2.0 does not support `note` tag)

**Session isolation**: Thread messages use key `${chatId}:thread:${threadId}` so threads don't share context with the main chat.

**Daemon** (`daemon.ts`): Self-daemonizes on first launch (forks to background with `NEOCLAW_DAEMON=1` env var, redirects I/O to `~/.neoclaw/logs/neoclaw.log`). Uses PID file (`~/.neoclaw/cache/neoclaw.pid`) with SIGTERM takeover of existing instance (up to 10s grace, then SIGKILL). `/restart` command saves `~/.neoclaw/cache/restart-notify.json` (contains `{ chatId, gatewayKind }`), forks a new process, then aborts the current one; new process waits 5s for gateways to initialize, then delivers restart confirmation via `dispatcher.sendTo()` (retries up to 3 times with 3s delay).

**Config** (`config.ts`): Loaded from env vars > `~/.neoclaw/config.json` > defaults. Env var prefix: `NEOCLAW_*` for agent/runtime, `FEISHU_*` for Feishu credentials.

Key config fields (`~/.neoclaw/config.json`):
```jsonc
{
  "agent": {
    "type": "claude_code",       // only supported value
    "model": "claude-sonnet-4-6", // Claude model override
    "systemPrompt": "...",        // extra system prompt
    "allowedTools": [],           // empty = --dangerously-skip-permissions
    "timeoutSecs": 600            // agent response timeout
  },
  "feishu": {
    "appId": "",
    "appSecret": "",
    "verificationToken": "",
    "encryptKey": "",
    "domain": "feishu",           // "feishu", "lark", or custom base URL
    "groupAutoReply": []          // chat IDs for auto-reply without @mention
  },
  "mcpServers": {                 // MCP servers exposed to agents (hot-reloaded)
    "server-name": {
      "type": "stdio",            // "stdio" | "http" | "sse"
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": {}
    }
  },
  "skillsDir": "~/.neoclaw/skills", // skill directories (each with SKILL.md)
  "logLevel": "info",             // "debug" | "info" | "warn" | "error"
  "workspacesDir": "~/.neoclaw/workspaces"  // base dir; per-conversation subdirs created on demand
}
```

Env var overrides: `NEOCLAW_AGENT_TYPE`, `NEOCLAW_MODEL`, `NEOCLAW_SYSTEM_PROMPT`, `NEOCLAW_ALLOWED_TOOLS`, `NEOCLAW_TIMEOUT_SECS`, `NEOCLAW_LOG_LEVEL`, `NEOCLAW_WORKSPACES_DIR`, `NEOCLAW_SKILLS_DIR`, `NEOCLAW_CONFIG` (config file path), `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY`, `FEISHU_DOMAIN`, `FEISHU_GROUP_AUTO_REPLY`.

**MCP & Skills workspace sync** (`ClaudeCodeAgent._prepareWorkspace()`): Runs each time a new Claude Code subprocess starts. `_syncMcpServers()` hot-reloads `mcpServers` from the config file (not cached opts) and writes `<workspace>/.mcp.json`. `_syncSkills()` reads `skillsDir`, symlinks valid skill directories (containing `SKILL.md`) into `<workspace>/.claude/skills/`, and removes stale symlinks for deleted skills.

## Conventions

- Full async/await — no sync blocking in async paths
- TypeScript strict mode with `noUncheckedIndexedAccess`
- Interfaces over class inheritance for loose coupling
- All runtime files (`logs/`, `cache/`, `workspaces/`, `skills/`) live under `~/.neoclaw/`; PID file at `~/.neoclaw/cache/neoclaw.pid`
- `Bun.spawn()` for subprocesses; `Bun.sleepSync()` only in daemon takeover loop
