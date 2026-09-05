# Local Codex Support extension

The Local Codex Support extension is the ChatGPT-specific companion to the MCP server. It is separate from `browser-extension/`, which controls general Chrome tabs.

The support extension handles four jobs:

- **Thread sync** binds the current ChatGPT conversation URL to the MCP caller's `openai/session` for `sync_current_thread` and `get_current_thread_url`.
- **Thread preparation executor** opens or reuses persistent tabs for observed conversation threads. Enable it only in the Chrome automation profile.
- **RALPH automation** inspects registered ChatGPT threads and sends a continuation when a due thread still needs work.
- **Agent thread messaging** executes the browser side of `start_subagent` and `send_thread_message`.

The popup has two tabs. **RALPH threads** shows registered threads with readable titles, state, recent activity, next check, errors, and parent information for sub-agents. **Settings** contains the browser feature toggles, Sub-agent project, RALPH timing, and the RALPH project allowlist.

Automation commands are claimed atomically by one enabled browser instance. Thread sync can be enabled in more than one compatible browser because binding is idempotent. Enable **Thread preparation executor** only in the Chrome automation profile. RALPH automation and Agent thread messaging should normally also be enabled in only one automation browser.

## Install

1. Run `pnpm support:prepare`. This builds the project and writes `.data/support-extension` with the private loopback token and generated endpoints.
2. Start or restart Local Codex. The support listener defaults to `http://127.0.0.1:6002`. Set `THREAD_SYNC_PORT` to use another port or `THREAD_SYNC_ENABLED=false` to disable the support listener.
3. Remove the obsolete **Local Codex Thread Sync** extension if it is still installed.
4. Load `.data/support-extension` as an unpacked extension. Load the generated directory, not the source `support-extension` directory.
5. Choose which browser handles each feature. Thread sync can run in multiple browsers. Enable **Thread preparation executor** only in the Chrome profile that the backend launches. Keep RALPH automation and Agent thread messaging on the browser that should execute those commands.
6. Set **Sub-agent project** if child conversations should be created inside a dedicated ChatGPT project. The value is stored on the Local Codex server and shared by executor browsers.
7. Reload the unpacked extension after rerunning `pnpm support:prepare`.

Keep `.data` private. It contains the support-extension credential, thread bindings, RALPH state, and RALPH audit logs.

## Thread sync

Thread Sync is a one-time binding for each ChatGPT conversation session.

1. The agent calls `sync_current_thread` only when a later action needs the current conversation binding. `start_subagent` requires this binding before the child is started.
2. If the tool reports `syncing`, the Thread Sync MCP App performs the browser handshake and the agent follows with `get_current_thread_url` before the binding-dependent action.
3. If the tool reports `synced`, it returns the saved URL immediately. No second handshake starts.

The support extension observes every ChatGPT `/c/...` route and reports it to the local backend, regardless of RALPH registration or Thread Sync state. The backend ensures that the thread is present in the automation browser even when it was already bound earlier. Duplicate observations share the same in-flight preparation, and a successful preparation is remembered for the rest of that server run.

The Chrome profile with **Thread preparation executor** enabled reuses a matching open conversation tab or creates one background tab when none exists. Preparation concurrency is still capped at three, but the tab itself is not tied to the preparation slot or Thread Sync handshake. The same tab remains available for title observation, RALPH, and later messaging while the thread is active.

## Sub-agents

`start_subagent` accepts only the child task. The parent must already have completed its one-time Thread Sync binding.

The server resolves the parent from `openai/session`, chooses the configured **Sub-agent project**, or falls back to `https://chatgpt.com/`. It creates a local job under `<DATA_DIR>/subagents/` and gives the child the job ID and result path. The child prompt does not contain the parent URL.

A child performs its bounded task without delegation. Before `submit_subagent_result`, it binds its own conversation with Thread Sync if needed. That tool stores the report in the assigned local `.md` file and releases the job's slot. Sub-agents are not created automatically for engineering or review work; `start_subagent` is reserved for explicit user-requested delegation.

The backend reserves at most two pending children per parent, including startups, and rejects nested delegation. Different root parents have independent limits. Capacity refusals name that parent's active jobs. Wait for result notices or continue independent work instead of polling or retrying. Reservations survive restart. Unconfirmed startup keeps its slot until the parent resolves the job. For a known child URL, `cancel_subagent` opens or reuses the thread, stops an active ChatGPT run, confirms the stop, closes the tab only when it is automation-owned, and then releases the slot. If stopping fails, the job stays pending.

Ready results for the same parent are collected for one second and delivered in one notice. RALPH defers parents with pending children or results awaiting notification, and skips further continuation for finished or cancelled children. Recognized visible English ChatGPT rate-limit alerts, dialogs, or toasts trigger a 15-minute cooldown shared by browser message commands. Rate-limited and already queued sends remain queued. A sub-agent start requested during cooldown reserves its parent slot and waits in the same message queue. After cooldown the deferred backlog drains at least five seconds apart; normal sends are no longer paced once that backlog is empty. Stop-thread cancellation remains available during cooldown. Restart clears the cooldown. The delay does not represent the account's actual quota.

The backend watches unfinished jobs. `start_subagent` waits until the child conversation has been prepared in the automation browser before returning normal startup success. If preparation fails after the child already exists, the job records the error and the tool surfaces it without creating another child. After a service restart, the registry marks a startup without a known child as interrupted so that the parent can resolve it. When result files contain data, the backend groups ready jobs by parent and sends one notice with their paths. The reports never travel through browser messaging. Failed parent wake-ups use exponential backoff and stop after five attempts; the terminal errors remain visible in `list_subagents`. The parent reads every listed file before continuing.

The child is registered for RALPH immediately and stores its parent thread ID.

`list_subagents` returns children created by the current synced parent and mounts the Sub-agent MCP App. The view includes each child's title, RALPH state, mode, result path, result state, recent activity, and errors.

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

Normal project threads are retained only when their project is in the RALPH project allowlist. Manually registered threads and agent-created sub-agents remain registered regardless of that allowlist.

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

**Stop continuous** restores normal completion checks. Marking the thread complete stops its scheduled checks. The running agent has no tool that disables continuous mode itself. Ending its turn leaves continuous mode enabled, so RALPH can wake it again when the thread is idle and due.

## Initial thread preparation

Thread preparation is independent from RALPH. The support extension reports every observed ChatGPT conversation route to `/chatgpt-support/threads/observe`.

`ThreadPreparationCoordinator` treats browser presence separately from Thread Sync binding. For every observed conversation it deduplicates repeated observations by thread ID, caps active preparations at three, starts Chrome only when no recent preparation executor is connected, and queues one `prepare_thread` command unless that thread was already prepared during the server run. Already-bound threads are still prepared so they are available to RALPH without waiting for a fresh page load.

The Chrome automation profile reuses an existing matching conversation tab or creates one background tab and remembers that it owns it. Thread Sync no longer closes the tab. RALPH inspection and existing-thread messages reuse the same tab, preventing a fresh ChatGPT page load every few minutes. Automation-owned tabs remain open while the RALPH thread is active and are cleaned up ten minutes after completion; a tab that was already open in the user's browser is reused but never closed by lifecycle cleanup. Helium can keep Thread Sync enabled to observe and report routes while **Thread preparation executor** remains off, so it never claims `threadPreparation`.

## Checks

Run:

```powershell
pnpm thread-sync-test
```

The test covers one-time thread binding, backend preparation deduplication, generated-extension configuration, local sub-agent result files, parent wake-ups, request-level send deduplication, parent-child registration, title extraction, single-shot browser sends, fixed settle timing, persistent-tab reuse and delayed cleanup, continuous RALPH behavior, project-scoped registration, settled-idle classification gating, recurring check timing, command claiming, and MCP App routing. It does not start a real browser or network listener.
