# ADR 0001: explicit ChatGPT URL binding and support automation

## Status

Accepted on 2026-08-27. Extended through 2026-09-04 with one-time thread binding, backend-owned thread preparation, local-file sub-agent results, parent wake-ups, parent-child tracking, readable thread titles, explicit continuous RALPH mode, and single-shot browser delivery.

## Context

ChatGPT gives Local Codex an opaque `openai/session`, while the browser knows the visible conversation URL. Thread sync must connect those two identities without guessing from titles, project routes, or browser history.

Sub-agents run in separate ChatGPT conversations. Their result must survive long-running work without depending on a child-to-parent browser callback. The local backend therefore owns result storage and parent notification.

The support extension can also run in more than one browser. Any command that changes a ChatGPT thread must execute at most once even when multiple extension instances are online.

## Decision

### Keep URL binding explicit and one-time

Thread Sync exposes two narrow MCP tools:

- `sync_current_thread` is the required first MCP action in a ChatGPT conversation. It creates the initial browser binding ticket only when the current `openai/session` is not already bound. A repeated call returns the saved conversation URL immediately.
- `get_current_thread_url` waits for the initial binding when `sync_current_thread` reports `syncing`. It never infers or constructs a conversation URL.

The binding is permanent for the lifetime of that stored session mapping. Repeating `sync_current_thread` does not refresh the URL, create another ticket, or mount another handshake.

The extension credential grants only the local binding and support routes. It does not grant MCP terminal or browser-control access.

### Prepare observed threads below the agent

Thread preparation is independent from RALPH registration. The support extension reports every observed ChatGPT `/c/...` route to the local backend.

`ThreadPreparationCoordinator` checks the stored bindings by thread ID. It returns immediately for a bound thread and deduplicates repeated observations for an unsynced thread. The command bus tracks recent executor polls and commands currently owned by a browser, so a busy Chrome instance still counts as connected. If no recent preparation executor exists, the backend deduplicates the launch and starts Chrome through the existing browser launcher. It queues `prepare_thread` commands with a maximum of three parked preparations at once. A successful preparation is remembered for the rest of the server run so an unsynced thread cannot repeatedly open parked tabs.

The support extension has an explicit **Thread preparation executor** setting. Enable it only in the Chrome automation profile. That profile opens the conversation in a parked background tab. A successful Thread Sync handshake releases the tab early. Helium only observes routes and reports them to the backend with the executor setting off, so it does not launch Chrome or claim preparation work.

### Keep delegation server-routed and file-backed

Delegation uses four MCP tools:

- `start_subagent` requires a synced parent. The server resolves the parent from `openai/session`, chooses the configured **Sub-agent project** or `https://chatgpt.com/`, creates a local result job, and starts the child.
- `submit_subagent_result` stores the child report in the job's local `.md` file.
- `send_thread_message` sends an explicit message to an existing `/c/...` conversation only. It is not the sub-agent return channel.
- `list_subagents` returns the children created by the current parent and includes their result path and result state.

The child receives its job ID and result path. It does not receive the parent URL. The child starts by syncing its own thread once, performs the bounded task, and finishes with `submit_subagent_result`. Nested delegation is not part of the default child behavior.

Before `start_subagent` reports normal startup success, the backend confirms that the child has a prepared Thread Sync tab. A preparation failure after child creation is stored on the job and returned to the parent without retrying child creation. The backend then watches completed jobs that have not notified their parent. Once a result file contains data, it sends the parent a small wake-up message containing only the job ID and local result path. Wake-up failures back off exponentially and become terminal after five attempts, with the error retained on the job. The parent reads the file for the report. This keeps browser messaging out of the result transport while preserving automatic parent continuation.

### Hide transport idempotency from the model

`start_subagent` and `send_thread_message` keep transport idempotency below the model-facing API. `send_thread_message` exposes only `targetUrl` and `message`; the model does not create or manage a `deliveryId`.

The server deduplicates retries of the same MCP request internally using the tool name, request identity, `openai/session`, and payload fingerprint. `send_thread_message` also fingerprints the normalized target. The replay cache is shared across stateless MCP server instances in the process. A new logical tool call remains a new send or a new child.

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

The extension reports readable ChatGPT titles during route updates, sends, and inspections so operator views do not need to identify threads by UUID alone.

RALPH stores two independent fields:

- `state` is `active` or `complete`.
- `mode` is `normal` or `continuous`.

Normal mode uses the worked-duration gate and completion classifier. Continuous mode is explicit per thread, skips completion classification, and sends a fixed continuation instruction when the thread is idle and due. Continuous mode never starts automatically.

### Claim automation commands atomically

The authenticated loopback command bus assigns each queued support command to one enabled browser instance. Thread sync may stay enabled in multiple browsers because binding is idempotent. Thread preparation has a separate executor setting so route observation does not imply permission to open parked tabs. RALPH automation and agent thread messaging should normally be enabled only in the browser intended to execute those commands.

## Consequences

The parent calls `sync_current_thread` once at the start of the conversation. If the initial binding is still pending, it follows with `get_current_thread_url`. After that, `start_subagent` can resolve the parent without refreshing the binding.

Sub-agents return reports through local files. The browser is used only to create child conversations and to wake parents after a result becomes available. Transport retries remain an implementation concern rather than part of the model-facing tool API.

Browser delivery favors duplicate prevention over speculative recovery. A prompt is inserted once and the send button is clicked once after explicit settle periods.

RALPH remains a continuation runtime. Normal work can complete. Continuous execution exists only after the user explicitly selects **Run continuously**.
