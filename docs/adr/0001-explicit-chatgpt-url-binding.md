# ADR 0001: explicit ChatGPT URL binding and support automation

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

`ThreadPreparationCoordinator` treats browser presence as independent from stored Thread Sync bindings. It deduplicates repeated observations by thread ID and prepares an observed thread even when that conversation was already bound earlier, because RALPH still needs the automation browser to keep the page available. The command bus tracks recent executor polls and commands currently owned by a browser, so a busy Chrome instance still counts as connected. A one-minute extension alarm wakes the Manifest V3 executor after service-worker suspension, and the backend keeps a presence grace window long enough to span that wake cycle. If no recent preparation executor exists, the backend deduplicates the launch and starts Chrome through the existing browser launcher, then waits for the executor to reconnect before treating the launch as successful. A missing executor therefore produces an explicit configuration error instead of a delayed `prepare_thread` timeout, and launch attempts are rate-limited so concurrent requests cannot create a window loop. It queues `prepare_thread` commands with a maximum of three active preparations at once. A successful preparation is remembered for the rest of the server run. The automation browser reuses an existing matching conversation tab or creates one persistent owned tab, avoiding repeated ChatGPT reloads for the same thread.

The support extension has an explicit **Thread preparation executor** setting. Enable it only in the Chrome automation profile. That profile opens or reuses a persistent conversation tab. A successful Thread Sync handshake leaves that tab in place for title observation, RALPH, and later messaging. Helium only observes routes and reports them to the backend with the executor setting off, so it does not launch Chrome or claim preparation work.

### Keep reviews server-routed and file-backed

The reviewer workflow exposes three reviewer-specific MCP tools:

- `start_reviewer` requires a synced implementer conversation, reserves one review job, starts the reviewer, and returns the exact ChatGPT review-thread URL.
- `list_reviewers` returns one status snapshot for reviews owned by the current synced implementer, including each known review-thread URL. Its contract explicitly forbids completion polling because the backend wakes the implementer after completion.
- `review_done` stores the reviewer's final report and completes the review job.

`start_thread` and `send_thread_message` remain separate, explicit user-requested conversation tools. They are not delegation or review APIs. Generic delegation start, list, cancel, or result tools are not exposed to ChatGPT.

Internally, the existing `SubagentJobRegistry` remains the persistence and reservation mechanism. That implementation detail does not appear in reviewer tool names, descriptions, MCP App identity, or normal operator status. Each implementer can have one unfinished review. A reviewer cannot start another reviewer or create another task thread. Repeated identical briefs reuse the saved job, and an uncertain startup keeps its reservation until the operator resolves it.

New jobs and report files use `<DATA_DIR>/reviews/`. When only the historical `<DATA_DIR>/subagents/` store exists, the registry reads it once, copies any existing reports into `reviews/`, rewrites the saved paths, and persists the canonical reviewer store. The old files are left in place so migration does not destroy rollback data. The historical `subagentProjectUrl` setting key remains accepted for compatibility.

The reviewer receives its job ID and result path, but not the implementer's conversation URL or callback transport. It calls `review_done` directly without syncing or looking up its URL. The backend uses the reviewer identity recorded on the job at startup. An existing session binding must match that identity, but completion does not require a binding or session metadata. The backend then waits until the reviewer is idle before sending the implementer a notice that points at the local report. Failed wake-ups back off and retain their errors for operator recovery.

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

The extension does not wait for an assistant turn before typing. It does not use DOM-stability signatures or post-send acknowledgement heuristics, and it does not automatically retry a click after an uncertain result.

### Keep RALPH state separate from thread binding

Reviewer threads are registered for RALPH immediately and store their implementer thread ID. Their registration does not depend on the normal RALPH project allowlist.

The extension reports readable ChatGPT titles during route updates, sends, and inspections so operator views do not need to identify threads by UUID alone.

RALPH stores two independent fields:

- `state` is `active` or `complete`.
- `mode` is `normal` or `continuous`.

Normal mode repeatedly inspects active threads. The default check interval is 180 seconds (3 minutes), and configured intervals below 120 seconds are rejected. Registration, running/loading observations, and continuations use the same interval. Loading and running only reschedule inspection. For a settled idle normal turn, an unavailable worked duration or a duration at or below 1200 seconds marks the thread complete locally; only a duration strictly above 20 minutes reaches the completion classifier. Continuous mode is explicit per thread, uses the same inspection loop, skips completion classification, and sends a fixed continuation instruction when the thread is settled, idle, and due. Continuous mode never starts automatically.

Continuous mode is operator-controlled. The agent has no MCP action that disables it. Ending a turn does not change the mode. The popup can switch the thread back to normal mode with **Stop continuous** or stop RALPH checks with **Mark complete**.

Both modes defer implementer threads while a review is pending or its report awaits notification. Finished and cancelled reviewer jobs suppress further reviewer continuation. Ready reports for an implementer share a one-second collection window and one wake-up. Visible recognized ChatGPT rate-limit notices trigger a shared 10-minute message cooldown. The failed rate-limited send and other queued sends remain queued. A reviewer start requested during cooldown also waits in that queue after reserving its parent slot. After cooldown the deferred backlog is claimed at least five seconds apart, and pacing turns off when the backlog is empty. Stop-thread commands bypass message cooldown. Cooldown state is not persisted across service restarts.

### Claim automation commands atomically

The authenticated loopback command bus assigns each queued support command to one enabled browser instance. Thread sync may stay enabled in multiple browsers because binding is idempotent. Thread preparation has a separate executor setting so route observation does not imply permission to open or retain automation tabs. RALPH automation and agent thread messaging should normally be enabled only in the browser intended to execute those commands.

## Consequences

The parent does not sync merely because a conversation started. Before `start_reviewer` or another binding-dependent operation, it calls `sync_current_thread`; if the binding is still pending, it immediately follows with `get_current_thread_url` and then continues the requested operation.

Reviewers return reports through local files. The browser creates reviewer conversations, exposes their URLs for navigation, and wakes implementers after a result becomes available. Transport retries remain an implementation concern rather than part of the model-facing tool API.

Browser delivery favors duplicate prevention over speculative recovery. A prompt is inserted once and the send button is clicked once after explicit settle periods.

Automation-owned conversation tabs are persistent working state. Creation, preparation, Thread Sync, title capture, RALPH inspection, and existing-thread messaging reuse the same tab. Active threads are never closed by lifecycle cleanup. Ten minutes after a RALPH thread becomes complete, the backend requests cleanup; only tabs recorded as automation-owned are closed, while pre-existing user tabs are left alone. Chrome launches request a new tab so an already-running profile is reused instead of intentionally creating a new window.

RALPH remains a continuation runtime. Normal work can complete. Continuous execution exists only after the user explicitly selects **Run continuously**.

### Observe existing tabs across browsers

Browser command polls now carry a complete inventory of open conversations. The command bus routes inspections to an existing browser, preferring an observer such as Helium when both browsers have the thread. Inventories expire after 90 seconds without a poll. Closing or navigating a tab updates the inventory. An observer never creates a tab or sends a message. Chrome remains the executor for message delivery and opens a background tab only when it needs one.

Helium route observations no longer schedule Chrome preparation. Inspections use Helium's current page without applying Chrome's external-revision refresh. Titles and settled-turn data use the same inspection path in both browsers.

Before revision refresh or automation, the extension checks visible provider notices. A rate-limit notice starts a persisted ten-minute wait. During that wait the extension neither reloads the tab nor dismisses the notice. Polling dismisses its Got It button after the wait, then checks the page again. Recognized timeout and network notices permit a reload of the same tab, at most once per ten minutes. Conversation text is excluded from notice matching. Uncertain message deliveries are never redispatched by recovery.
