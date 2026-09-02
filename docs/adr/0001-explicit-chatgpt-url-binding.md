# ADR 0001: explicit ChatGPT URL binding and support automation

## Status

Accepted on 2026-08-27. Extended through 2026-09-02 with first-class sub-agent tools, parent-child tracking, readable thread titles, explicit continuous RALPH mode, single-shot browser delivery, and request-level callback deduplication.

## Context

ChatGPT gives Local Codex an opaque `openai/session`, while the browser knows the visible conversation URL. Thread sync must connect those two identities without guessing from titles, project routes, or browser history.

Sub-agents run in separate ChatGPT conversations. A normal assistant reply in a child conversation does not return to the parent. Child creation and callback delivery therefore need an explicit browser automation path.

The support extension can also run in more than one browser. Any command that changes a ChatGPT thread must execute at most once even when multiple extension instances are online.

## Decision

### Keep URL binding explicit

Thread Sync exposes two narrow MCP tools:

- `sync_current_thread` mounts the Thread Sync MCP App and starts the browser binding handshake for the calling `openai/session`.
- `get_current_thread_url` reads the stored binding. It never infers or constructs a conversation URL.

The extension credential grants only the local binding and support routes. It does not grant MCP terminal or browser-control access.

### Keep delegation server-routed

Delegation uses three MCP tools:

- `start_subagent` requires a freshly synced parent. The server reads the parent URL from the caller's `openai/session`, chooses the configured **Sub-agent project** or `https://chatgpt.com/`, and adds a mandatory callback procedure to the child prompt.
- `send_thread_message` sends to an existing `/c/...` conversation only.
- `list_subagents` returns the children created by the current parent and renders the Sub-agent MCP App.

The browser extension executes a resolved target. It does not choose a project or infer a parent.

The child callback instruction requires `send_thread_message` before the child's final assistant response. A normal child response is explicitly described as local to that child and not as delivery to the parent.

### Hide transport idempotency from the model

`send_thread_message` exposes only `targetUrl` and `message`. The model does not create or manage a `deliveryId`.

The server deduplicates retries of the same MCP request internally using the request identity, `openai/session`, normalized target, and message fingerprint. The replay cache is shared across stateless MCP server instances in the process. A new logical tool call remains a new send.

This keeps transport retry handling below the tool contract instead of requiring the model to preserve an idempotency token across attempts.

### Use one conservative browser send path

The support extension uses one single-shot send procedure for new child prompts and messages to existing threads:

1. Existing conversations wait for a loaded user turn.
2. The page settles for five seconds.
3. The extension finds the composer and inserts the message once.
4. The message settles for five seconds.
5. The extension waits for an actionable send button and clicks it once.
6. New conversations wait for their saved `/c/...` URL.

The extension does not wait for an assistant turn before typing. It does not use DOM-stability signatures or post-send acknowledgement heuristics, and it does not automatically retry a click after an uncertain result.

### Keep RALPH state separate from thread binding

Agent-created children are registered for RALPH immediately and store their parent thread ID. Their registration does not depend on the normal RALPH project allowlist.

A fresh RALPH registration schedules a `prepare_thread` command on the browser that owns RALPH automation. This applies to normal allowlisted project threads, manually registered threads, and agent-created sub-agents. The browser opens the conversation in a parked background tab for up to two minutes. A successful `sync_current_thread` handshake releases the tab early.

The extension reports readable ChatGPT titles during route updates, sends, and inspections so operator views do not need to identify threads by UUID alone.

RALPH stores two independent fields:

- `state` is `active` or `complete`.
- `mode` is `normal` or `continuous`.

Normal mode uses the worked-duration gate and completion classifier. Continuous mode is explicit per thread, skips completion classification, and sends a fixed continuation instruction when the thread is idle and due. Continuous mode never starts automatically.

### Claim automation commands atomically

The authenticated loopback command bus assigns each queued support command to one enabled browser instance. Thread sync may stay enabled in multiple browsers because binding is idempotent. RALPH automation and agent thread messaging should normally be enabled only in the browser intended to execute those commands.

## Consequences

The parent agent has one required setup sequence before delegation: `sync_current_thread`, then `get_current_thread_url`, then `start_subagent`. The server owns target resolution and callback instructions.

Sub-agents do not need to manage callback UUIDs. Transport retries are an implementation concern rather than part of the model-facing tool API.

Browser delivery favors duplicate prevention over speculative recovery. A prompt is inserted once and the send button is clicked once after explicit settle periods.

RALPH remains a continuation runtime. Normal work can complete. Continuous execution exists only after the user explicitly selects **Run continuously**.
