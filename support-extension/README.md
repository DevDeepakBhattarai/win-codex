# Local Codex Support extension

The Local Codex Support extension is the ChatGPT-specific companion to the MCP server. It is separate from `browser-extension/`, which controls general Chrome tabs.

The support extension handles three jobs:

- **Thread sync** binds the current ChatGPT conversation URL to the MCP caller's `openai/session` for `sync_current_thread` and `get_current_thread_url`.
- **RALPH automation** inspects registered ChatGPT threads and sends a continuation when a due thread still needs work.
- **Agent thread messaging** executes the browser side of `start_subagent` and `send_thread_message`.

The popup has two tabs. **RALPH threads** shows registered threads with readable titles, state, recent activity, next check, errors, and parent information for sub-agents. **Settings** contains the browser feature toggles, Sub-agent project, RALPH timing, and the RALPH project allowlist.

Automation commands are claimed atomically by one enabled browser instance. Thread sync can be enabled in more than one compatible browser because binding is idempotent. RALPH automation and Agent thread messaging should normally be enabled in only one browser.

## Install

1. Run `pnpm support:prepare`. This builds the project and writes `.data/support-extension` with the private loopback token and generated endpoints.
2. Start or restart Local Codex. The support listener defaults to `http://127.0.0.1:6002`. Set `THREAD_SYNC_PORT` to use another port or `THREAD_SYNC_ENABLED=false` to disable the support listener.
3. Remove the obsolete **Local Codex Thread Sync** extension if it is still installed.
4. Load `.data/support-extension` as an unpacked extension. Load the generated directory, not the source `support-extension` directory.
5. Choose which browser handles each feature. Thread sync can run in multiple browsers. Keep RALPH automation and Agent thread messaging on the browser that should execute automation commands.
6. Set **Sub-agent project** if child conversations should be created inside a dedicated ChatGPT project. The value is stored on the Local Codex server and shared by executor browsers.
7. Reload the unpacked extension after rerunning `pnpm support:prepare`.

Keep `.data` private. It contains the support-extension credential, thread bindings, RALPH state, and RALPH audit logs.

## Thread sync

Thread lookup is an explicit two-step flow:

1. Call `sync_current_thread` from the ChatGPT conversation that needs a binding.
2. Call `get_current_thread_url` after the sync handshake succeeds.

`get_current_thread_url` only reads an existing binding. It never infers a conversation URL from a project, title, browser tab, or previous thread.

A fresh RALPH registration may open the thread in a parked background tab so the agent has a page on which to mount Thread Sync. A successful sync closes that parked tab early.

## Sub-agents

`start_subagent` accepts only the child task. It does not accept a project or conversation target. The parent must call `sync_current_thread` and then `get_current_thread_url` before starting a child.

The server resolves the parent from `openai/session`, chooses the configured **Sub-agent project**, or falls back to `https://chatgpt.com/`. It appends the bound parent URL and a mandatory callback procedure to the child task.

The callback procedure tells the child to:

1. Finish the assigned work in the child conversation.
2. Call `send_thread_message` exactly once before producing its final assistant response.
3. Put the complete final report in the tool's `message` argument.
4. Treat a normal assistant reply in the child as local to that child, not as delivery to the parent.
5. Never retry the callback after the tool returns, even after an uncertain transport result.

The child is registered for RALPH immediately and stores its parent thread ID.

`list_subagents` returns the children created by the current synced parent and mounts the Sub-agent MCP App. The view includes each child's title, RALPH state, mode, recent activity, and errors.

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

Normal RALPH uses a worked-duration gate and, when required, an OpenAI completion classifier.

- The first check defaults to 1500 seconds after registration or reactivation.
- A still-running thread is checked again after 300 seconds.
- The default **RALPH minimum worked time** is 1140 seconds.
- When an idle thread reports more than the configured minimum, the server sends the compact transcript to the classifier.
- `COMPLETE` marks the thread complete. Any other valid classifier result becomes the short continuation instruction.
- A short or unavailable worked duration completes a normal thread without a classifier call.

Normal classification requires `OPENAI_API_KEY`. The model defaults to `gpt-5.6-terra` and can be changed with `RALPH_MODEL`.

Classification requests and results are written to `<DATA_DIR>/ralph-openai.log`, which defaults to `.data/ralph-openai.log`. The API key is never written to that log.

### Continuous mode

Continuous mode must be selected explicitly per thread. When an idle continuous thread is due, RALPH skips the worked-duration completion gate and the OpenAI completion classifier. It sends a fixed continuation instruction that tells the agent to reread the current state and execute the next useful improvement, experiment, verification, or cleanup toward the existing goal.

The thread stays active until the user selects **Stop continuous** or marks it complete.

## Initial thread preparation

Every fresh RALPH registration schedules `prepare_thread` in the browser that owns RALPH automation. This applies to normal allowlisted project threads, manually registered threads, and agent-created sub-agents.

The RALPH browser opens the saved conversation in a background tab and keeps it available for up to two minutes. If the agent completes `sync_current_thread`, the binding handshake closes the parked tab immediately. Duplicate route observations, title updates, and ordinary reactivations do not schedule another initial preparation tab.

## Checks

Run:

```powershell
pnpm thread-sync-test
```

The test covers thread binding, generated-extension configuration, sub-agent callback injection, request-level callback deduplication, parent-child registration, title extraction, single-shot browser sends, fixed settle timing, parked-tab release, continuous RALPH behavior, project-scoped registration, duration gating, command claiming, and MCP App routing. It does not start a real browser or network listener.
