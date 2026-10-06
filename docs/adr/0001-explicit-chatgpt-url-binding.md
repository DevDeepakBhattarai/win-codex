# ADR 0001: explicit ChatGPT URL binding and support automation

The reviewer workflow and default continuation in this historical decision are superseded by [ADR 0002](0002-bounded-task-delegation.md).

## Status

Accepted on 2026-08-27. Extended through 2026-09-06 with one-time thread binding, backend-owned thread preparation, file-backed reviewer reports, parent wake-ups, reviewer tracking, readable thread titles, explicit continuous RALPH mode, and single-shot browser delivery.

## Context

ChatGPT gives Local Codex an opaque `openai/session`, while the browser knows the visible conversation URL. Thread sync must connect those two identities without guessing from titles, project routes, or browser history.

Independent reviewers run in separate ChatGPT conversations. Their reports must survive long-running work without depending on a reviewer-to-implementer browser callback. The local backend therefore owns report storage and parent notification.

The support extension can also run in more than one browser. Any command that changes a ChatGPT thread must execute at most once even when multiple extension instances are online.

## Current review workflow

The public workflow is reviewer-specific. ChatGPT receives `start_reviewer`, `list_reviewers`, and `review_done`; it does not receive generic delegation tools. The implementation keeps the existing flat local job registry underneath that API because its reservation, persistence, and parent-notification behavior still fits the reviewer lifecycle.

## Decision

### Keep URL binding explicit and one-time

Thread Sync exposes two narrow MCP tools:

- `sync_current_thread` is an on-demand prerequisite when an operation needs the current conversation binding. It creates the initial browser binding ticket only when the current `openai/session` is not already bound. `start_reviewer` requires that binding before the review begins. A repeated call returns the saved conversation URL immediately.
- `get_current_thread_url` waits for the initial binding when `sync_current_thread` reports `syncing`. It never infers or constructs a conversation URL.

The binding is permanent for the lifetime of that stored session mapping. Repeating `sync_current_thread` does not refresh the URL, create another ticket, or mount another handshake.

The extension credential grants only the local binding and support routes. It does not grant MCP terminal or browser-control access.

### Prepare observed threads below the agent

Thread preparation is independent from RALPH registration. The support extension reports every observed ChatGPT `/c/...` route to the local backend.

`ThreadPreparationCoordinator` treats browser presence as independent from stored Thread Sync bindings. It deduplicates repeated observations by thread ID and prepares an observed thread even when that conversation was already bound earlier, because RALPH still needs the automation browser to keep the page available. The command bus tracks recent executor polls and commands currently owned by a browser, so a busy Chrome instance still counts as connected. A one-minute extension alarm wakes the Manifest V3 executor after service-worker suspension, and the backend keeps browser presence long enough to span that interval. If no recent preparation executor exists, preparation starts Chrome when closed and waits for the extension connection before treating launch as successful. A running Chrome instance is reused without another launch. A missing executor fails with an explicit configuration error instead of repeatedly opening Chrome. It queues `prepare_thread` commands with a maximum of three active preparations at once. A successful preparation is remembered for the rest of the server run. The automation browser reuses a matching conversation tab or opens one in an existing window when missing.

The support extension has an explicit **Automation browser executor** setting. Enable it only in the Chrome automation profile. That profile reuses an existing conversation tab or opens a missing one. A successful Thread Sync handshake leaves that tab in place for title observation, RALPH, and later messaging. Helium only observes routes and reports them to the backend with the executor setting off, so it does not launch Chrome or claim preparation work.

### Keep reviews server-routed and file-backed

The reviewer workflow exposes three reviewer-specific MCP tools:

- `start_reviewer` requires a synced implementer conversation, reserves one review job, starts the reviewer, and returns the exact ChatGPT review-thread URL.
- `list_reviewers` returns one status snapshot for reviews owned by the current synced implementer, including each known review-thread URL. Its contract explicitly forbids completion polling because the backend wakes the implementer after completion.
- `review_done` stores the reviewer's final report and completes the review job.

`start_thread` and `send_thread_message` remain separate, explicit user-requested conversation tools. They are not delegation or review APIs. Generic delegation start, list, cancel, or result tools are not exposed to ChatGPT.

Internally, the existing `SubagentJobRegistry` remains the persistence and reservation mechanism. That implementation detail does not appear in reviewer tool names, descriptions, MCP App identity, or normal operator status. Each implementer can have one unfinished review. A reviewer cannot start another reviewer or create another task thread. Repeated identical briefs reuse the saved job, and an uncertain startup keeps its reservation until the operator resolves it.

New jobs and report files use `<DATA_DIR>/reviews/`. When only the historical `<DATA_DIR>/subagents/` store exists, the registry reads it once, copies any existing reports into `reviews/`, rewrites the saved paths, and persists the canonical reviewer store. The old files are left in place so migration does not destroy rollback data. The historical `subagentProjectUrl` setting key remains accepted for compatibility.

The reviewer receives its job ID and result path, but not the implementer's conversation URL or callback transport. It binds its own reviewer conversation before `review_done` when needed. The backend then waits until the reviewer is idle before sending the implementer a notice that points at the local report. Failed wake-ups back off and retain their errors for operator recovery.

The review-thread URL is first-class status, not hidden metadata. `start_reviewer` and `list_reviewers` include it in visible tool output, the reviewer MCP App displays it, and the RALPH popup Reviews section displays and opens the same URL. Local result paths remain report transport, not the primary review navigation UI.

### Hide transport idempotency from the model

`start_reviewer` and `send_thread_message` keep transport idempotency below the model-facing API. `send_thread_message` exposes only `targetUrl` and `message`; the model does not create or manage a `deliveryId`.

The server deduplicates retries of the same MCP request internally using the tool name, request identity, `openai/session`, and payload fingerprint. `send_thread_message` also fingerprints the normalized target. The replay cache is shared across stateless MCP server instances in the process. A new logical tool call remains a new send or a new review.

This keeps transport retry handling below the tool contract instead of requiring the model to preserve an idempotency token across attempts.

### Use one conservative browser send path

The support extension uses one single-shot send procedure for new reviewer prompts and messages to existing threads:

1. Existing conversations wait for a loaded user turn.
2. The page settles for five seconds.
3. The extension finds the composer and inserts the message once.
4. The message settles for five seconds.
5. The extension waits for an actionable send button and clicks it once.
6. New conversations wait for their saved `/c/...` URL.

The extension does not wait for an assistant turn before typing. It does not use DOM-stability signatures or post-send acknowledgement heuristics. If a page error occurs before the send click, it refreshes the tab once and retries. An uncertain result after the click refreshes the tab but never repeats the click.

### Keep RALPH state separate from thread binding

Reviewer threads are registered for RALPH immediately and store their implementer thread ID. Their registration does not depend on the normal RALPH project allowlist.

The extension reports readable ChatGPT titles during route updates, sends, and inspections so operator views do not need to identify threads by UUID alone.

RALPH stores two independent fields:

- `state` is `active` or `complete`.
- `mode` is `normal` or `continuous`.

Normal mode repeatedly inspects active threads. The default check interval is 180 seconds (3 minutes), and configured intervals below 120 seconds are rejected. Registration, running/loading observations, and continuations use the same interval. Loading and running only reschedule inspection. For a settled idle normal turn, an unavailable worked duration or a duration at or below 1200 seconds marks the thread complete locally; only a duration strictly above 20 minutes reaches the completion classifier. Continuous mode is explicit per thread, uses the same inspection loop, skips completion classification, and sends a fixed continuation instruction when the thread is settled, idle, and due. Continuous mode never starts automatically.

Continuous mode is operator-controlled. The agent has no MCP action that disables it. Ending a turn does not change the mode. The popup can switch the thread back to normal mode with **Stop continuous** or stop RALPH checks with **Mark complete**.

Both modes defer implementer threads while a review is pending or its report awaits notification. Finished and cancelled reviewer jobs suppress further reviewer continuation. Ready reports for an implementer share a one-second collection window and one wake-up. Visible recognized ChatGPT rate-limit notices trigger a shared 10-minute message cooldown. The extension persists the first-seen provider-notice time across service-worker restarts and does not reload or dismiss the notice during that interval. Sends blocked before the Send click remain queued for retry after cooldown. If the provider notice appears after Send was clicked, delivery is uncertain and the command is not replayed automatically. Page errors and timeouts refresh the same tab once and retry inspection when safe. Stop-thread commands bypass message cooldown.

### Claim automation commands atomically

The authenticated loopback command bus assigns each queued support command to one enabled browser instance. Thread sync may stay enabled in multiple browsers because binding is idempotent. Thread preparation has a separate executor setting so route observation does not imply permission to open or retain automation tabs. RALPH automation and agent thread messaging should normally be enabled only in the browser intended to execute those commands.

## Consequences

The parent does not sync merely because a conversation started. Before `start_reviewer` or another binding-dependent operation, it calls `sync_current_thread`; if the binding is still pending, it immediately follows with `get_current_thread_url` and then continues the requested operation.

Reviewers return reports through local files. The browser creates reviewer conversations, exposes their URLs for navigation, and wakes implementers after a result becomes available. Transport retries remain an implementation concern rather than part of the model-facing tool API.

Browser delivery retries a prompt after one refresh only when the page confirms that the send button was not clicked. An uncertain send remains an error for inspection instead of risking a duplicate prompt.

Automation-owned conversation tabs are persistent working state. Creation, preparation, Thread Sync, title capture, RALPH inspection, and existing-thread messaging reuse the same tab. Active threads are never closed by lifecycle cleanup. Ten minutes after a RALPH thread becomes complete, the backend requests cleanup; only tabs recorded as automation-owned are closed, while pre-existing user tabs are left alone. Support work starts Chrome when the configured browser is closed. A running browser is reused without another launch. New message tabs target an existing normal window explicitly.

RALPH remains a continuation runtime. Normal work can complete. Continuous execution exists only after the user explicitly selects **Run continuously**.


### Reuse an existing conversation across browsers

Every support-extension poll includes the normalized conversation URLs already open in that browser. The command bus keeps this inventory for the same 25-second heartbeat window used for browser presence. An `inspect_thread` or `prepare_thread` command is routed to a browser that already has the target conversation, preferring a read-only observer such as Helium when one is available. If no browser reports the thread, RALPH starts the Chrome executor when needed and opens a missing conversation tab in its existing window.

An observer may inspect only a conversation that it already has open. It cannot create tabs or claim queued message sends. A route observation from a browser whose preparation executor is disabled records presence without scheduling Chrome preparation. This lets RALPH inspect and capture titles from Helium without opening or refreshing Chrome every loop, while RALPH continuation messages require an idle check in the Chrome executor, which starts and opens a missing thread tab when needed.

Before any inspection or automation command, the extension checks visible provider notices. The separate **Recover interrupted chats** setting enables local Stop and continuation in the reporting browser, including observer browsers and user-opened tabs. A rate limit waits ten minutes before dismissal and continuation. Recoverable timeout and network notices trigger Stop and continuation in the same tab. This local recovery does not claim executor commands, create Chrome copies, or enable RALPH. Recovery does not retry an uncertain side-effecting send.

Closing an individual tracked conversation tab removes its RALPH entry and cancels queued checks. The extension persists removal reports while the server is offline and retries them after reconnecting. Stale checks cannot recreate a deliberately closed tab. Closing a browser window preserves registered threads so RALPH can restore their tabs after Chrome restarts.
