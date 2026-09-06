# Local Codex Support extension

The Local Codex Support extension is the ChatGPT-specific companion to the MCP server. It is separate from `browser-extension/`, which controls general Chrome tabs.

The support extension handles four jobs:

- **Thread sync** binds the current ChatGPT conversation URL to the MCP caller's `openai/session` for `sync_current_thread` and `get_current_thread_url`.
- **Automation browser executor** opens or reuses persistent tabs for active registered automation threads. Enable it only in the Chrome automation profile.
- **RALPH automation** inspects registered ChatGPT threads and sends a continuation when a due thread still needs work.
- **Agent thread messaging** executes the browser side of `start_reviewer` and `send_thread_message`.

The popup has two tabs. **RALPH threads** shows registered threads with readable titles, state, recent activity, next check, errors, and parent information for reviewers. **Settings** contains the browser feature toggles, Reviewer project, RALPH timing, and the RALPH project allowlist.

Automation commands are claimed atomically by one enabled browser instance. Thread sync can be enabled in more than one compatible browser because binding is idempotent. Enable **Automation browser executor** only in the Chrome automation profile. RALPH automation, Agent thread messaging, and tab cleanup require this executor setting. Keep it off in Helium.

## Install

1. Run `pnpm support:prepare`. This builds the project and writes `.data/support-extension` with the private loopback token and generated endpoints.
2. Start or restart Local Codex. The support listener defaults to `http://127.0.0.1:6002`. Set `THREAD_SYNC_PORT` to use another port or `THREAD_SYNC_ENABLED=false` to disable the support listener.
3. Remove the obsolete **Local Codex Thread Sync** extension if it is still installed.
4. Load `.data/support-extension` as an unpacked extension. Load the generated directory, not the source `support-extension` directory.
5. Choose which browser handles each feature. Thread sync can run in multiple browsers. Enable **Automation browser executor** only in the Chrome profile that the backend launches. Keep RALPH automation and Agent thread messaging on the browser that should execute those commands.
6. Set **Reviewer project** if reviewer conversations should be created inside a dedicated ChatGPT project. The value is stored on the Local Codex server and shared by executor browsers.
7. Reload the unpacked extension after rerunning `pnpm support:prepare`.

Keep `.data` private. It contains the support-extension credential, thread bindings, RALPH state, and RALPH audit logs.

## Thread sync

Thread Sync is a one-time binding for each ChatGPT conversation session.

1. The agent calls `sync_current_thread` only when a later action needs the current conversation binding. `start_reviewer` requires this binding before the reviewer is started.
2. If the tool reports `syncing`, the Thread Sync MCP App performs the browser handshake and the agent follows with `get_current_thread_url` before the binding-dependent action.
3. If the tool reports `synced`, it returns the saved URL immediately. No second handshake starts.

The support extension reports observed ChatGPT routes to the backend. Observation and Thread Sync binding do not grant automation ownership. Only an active registered RALPH thread can be prepared from an observation. Ordinary projects stay in Helium. Explicit reviewer creation and authorized thread messages retain their own automation lifecycle.

The Chrome profile with **Automation browser executor** enabled reuses a matching open conversation tab or creates one background tab when none exists. Preparation concurrency is still capped at three, but the tab itself is not tied to the preparation slot or Thread Sync handshake. The same tab remains available for title observation, RALPH, and later messaging while the thread is active.

## Review handoff

When `THREAD_SYNC_ENABLED` is not `false`, the server exposes:

- `sync_current_thread` binds the current MCP session to its conversation once. Repeated calls reuse the binding.
- `get_current_thread_url` finishes a pending binding without opening another widget.
- `start_reviewer` starts one independent review for a synced parent and returns the exact ChatGPT review-thread URL. The implementer ends its turn immediately after handoff.
- `list_reviewers` returns a snapshot of reviews owned by the current synced parent, including known review-thread URLs. It is not a polling mechanism.
- `review_done` stores the reviewer's complete report. The service waits for reviewer idle before waking the parent with the report path.
- `start_thread` creates a separate conversation only on an explicit user request. It adds no review job or callback.
- `send_thread_message` sends an explicitly requested message to an existing conversation.

Generic delegation tools are not exposed to ChatGPT. Reviewers reuse the existing local job machinery internally, but model-facing tools and the MCP App use reviewer terminology only. A parent can have one unfinished review, including startup and report delivery. Different user-started parents remain independent. Nested reviewers are rejected.

The Reviewer project setting chooses where reviews start, with chatgpt.com as the default. New report state lives under `<DATA_DIR>/reviews/`. On first open, legacy `<DATA_DIR>/subagents/` jobs and report files are copied forward and rewritten to the reviewer directory. The historical `subagentProjectUrl` setting key remains readable for compatibility.

Repeated identical review briefs reuse their saved job across restarts. Include the current PR head SHA in each brief so a review of changed code is a new assignment. An uncertain startup keeps its reservation. Inspect it in the extension before cancelling. Known reviewers are stopped before cancellation releases the reservation. Unknown startups require confirmation that any untracked reviewer has stopped. Late reports from cancelled jobs are rejected.

The popup shows pending startup, review progress, delivery failure, cancellation, and the exact review-thread URL. Use the URL or review title to open the reviewer. Use **Cancel review** to stop an abandoned reviewer. Use **Retry parent wake-up** after fixing an abandoned delivery. Completed reviews remain available under **Completed**. Parents waiting for review are labelled explicitly and cannot be resumed by **Check now**.

## Thread message delivery

`send_thread_message` accepts two public inputs:

- `targetUrl`: an existing ChatGPT `/c/...` conversation URL.
- `message`: the message to send.

It cannot create a conversation. It does not expose a `deliveryId` or any other caller-managed idempotency token.

The server deduplicates transport retries of the same MCP request internally. The replay key includes the MCP request identity, `openai/session`, normalized target URL, and message payload. Repeating the same transport request returns the cached result instead of queueing another browser send. A new logical tool call is a new send.

The browser-side send path is deliberately single-shot:

1. For an existing conversation, wait until at least one user turn is loaded. A new-chat page skips this step.
2. Wait five seconds for the ChatGPT page to settle.
3. Wait for the composer and insert the message once.
4. Wait another five seconds.
5. Wait for an actionable send button and click it once.
6. For a new conversation, wait for ChatGPT to navigate to its saved `/c/...` URL.

The extension does not wait for an assistant turn before typing. It no longer uses DOM-stability signatures or post-send acknowledgement heuristics. It also does not perform an automatic second click or message retry.

## RALPH behavior

RALPH registration is independent from Thread Sync. The server stores the registry in `.data/ralph.json`.

Normal project threads are retained only when their project is in the RALPH project allowlist. Manually registered threads and agent-created reviewers remain registered regardless of that allowlist.

The extension reports the readable ChatGPT title during route updates, sends, and inspections. The registry stores the title so the popup can display a useful name instead of a thread UUID.

The **RALPH threads** tab has Active and Completed views. An active row can be checked immediately, marked complete, or switched to **Run continuously**. A completed row can also be switched to continuous mode, which reactivates it. **Stop continuous** changes the mode back to normal without marking the thread complete.

### Normal mode

Normal RALPH uses a repeated inspection loop and an OpenAI completion classifier.

- The default **RALPH check interval** is 180 seconds (3 minutes), and the UI/server reject intervals below 120 seconds.
- Registration, reactivation, running turns, loading pages, and successful continuations all schedule the next inspection with that same interval.
- `loading` and `running` inspection results never call the classifier; they only schedule another check.
- The default **RALPH classifier worked-time threshold** is 1200 seconds (20 minutes). A settled idle turn at or below the threshold, or with no usable worked duration, is marked complete without a classifier call.
- Only a settled idle turn strictly above the threshold reaches the classifier. `COMPLETE` marks it complete; any other valid classifier result becomes the short continuation instruction.
- Actual inspection or classifier failures use a separate failure backoff instead of the rapid normal loop.

Normal classification requires `OPENAI_API_KEY`. The model defaults to `gpt-5.6-terra` and can be changed with `RALPH_MODEL`.

Classification requests and results are written to `<DATA_DIR>/ralph-openai.log`, which defaults to `.data/ralph-openai.log`. The API key is never written to that log.

### Continuous mode

Continuous mode must be selected explicitly per thread. It uses the same repeated inspection interval. When a settled idle continuous thread is due, RALPH skips the OpenAI completion classifier and sends a fixed continuation instruction that tells the agent to reread the current state and execute the next useful improvement, experiment, verification, or cleanup toward the existing goal.

**Stop continuous** restores normal completion checks. Marking the thread complete stops its scheduled checks. An ordinary idle turn leaves continuous mode enabled. Explicit COMPLETE or BLOCKED checkpoints stop scheduled continuation.

## Initial thread preparation

The observation endpoint checks the RALPH registry before scheduling preparation. Unregistered and completed threads return `ignored` without launching Chrome or queuing a command. Project registration remains subject to the RALPH allowlist. Explicit manual registrations and agent-created threads are retained.

`ThreadPreparationCoordinator` deduplicates eligible preparations by thread ID, caps active preparations at three, and remembers successful preparation during the server run. Binding alone never opens Chrome.

External composer activity in Helium records a persistent revision for registered conversations when a turn starts or finishes. Automation commands carry that revision. Chrome refreshes a matching idle tab once per changed revision before using it. A running or loading tab defers the refresh. Route changes, title updates, and unchanged RALPH cycles do not reload the page. Automation commands execute in order within the browser, and overlapping pollers share execution of the same command.

The Chrome automation profile reuses an existing matching conversation tab or creates one background tab and remembers that it owns it. Thread Sync no longer closes the tab. RALPH inspection and existing-thread messages reuse the same tab, preventing a fresh ChatGPT page load every few minutes. Automation-owned tabs remain open while the RALPH thread is active and are cleaned up ten minutes after completion; a tab that was already open in the user's browser is reused but never closed by lifecycle cleanup. Helium can keep Thread Sync enabled to observe and report routes while **Automation browser executor** remains off, so it never claims automation commands.

The executor also keeps a one-minute extension alarm while automation is enabled. This wakes the Manifest V3 service worker after Chrome suspends it, so the backend continues to see the existing Chrome executor instead of launching another Chrome instance. When the backend does have to launch Chrome, it now waits for the support extension to reconnect before considering the launch successful; a missing or disabled executor fails with an explicit configuration error instead of leaving `prepare_thread` queued until its long timeout.

## Checks

Run:

```powershell
pnpm thread-sync-test
```

The test covers one-time thread binding, backend preparation deduplication, generated-extension configuration, local reviewer result files, parent wake-ups, request-level send deduplication, parent-child registration, title extraction, single-shot browser sends, fixed settle timing, persistent-tab reuse and delayed cleanup, continuous RALPH behavior, project-scoped registration, settled-idle classification gating, recurring check timing, command claiming, and MCP App routing. It does not start a real browser or network listener.


## Engineering checkpoints and browser load

See the [sequential engineering workflow](../README.md#sequential-engineering-workflow) for the skill sequence and RALPH status lines. CONTINUE and WAIT_CI bypass the classifier, including for short turns. WAIT_CI delays the next wake-up for five minutes. Pending reviewers suppress parent inspection and continuation. Report submission alone does not wake a parent until the reviewer is idle.

New reviewers already have an automation-owned tab, so startup records preparation without another browser command. Route observations are coalesced for one minute per conversation. Working-browser observations never claim execution. Matching tabs are reused, and only an actual external conversation revision can cause an idle automation tab to reload. Ordinary observation, title updates, and timer ticks do not reload it.
