# Local Codex Support extension

This is the ChatGPT support extension for Local Codex. It is separate from `browser-extension/`, which is the general browser-control bridge.

## Features

The popup has two tabs. **RALPH threads** shows the server's registered threads with readable titles, state, recent activity, next check, errors, and parent thread when the entry is a sub-agent. **Settings** holds the browser feature toggles, the Sub-agent project, RALPH timing, and the RALPH project allowlist.

- **Thread sync** supports `sync_current_thread` and `get_current_thread_url`. It can be enabled in Chrome and Helium at the same time.
- **RALPH automation** inspects registered ChatGPT threads and sends continuation messages when required.
- **Agent thread messaging** executes `start_subagent` and `send_thread_message` commands. Enable it only in the browser that should create and message agent threads.

The server atomically assigns each automation command to one enabled browser instance, so duplicate execution is prevented even if the same automation toggle is enabled in two browsers.

## Install

1. Run `pnpm support:prepare`. This builds the project and writes `.data/support-extension` with its private loopback token and generated endpoints.
2. Start or restart Local Codex. The support listener uses `http://127.0.0.1:6002` by default. `THREAD_SYNC_PORT` changes that port, and `THREAD_SYNC_ENABLED=false` disables the support listener.
3. Remove the obsolete **Local Codex Thread Sync** unpacked extension if it is still installed. Load `.data/support-extension` as an unpacked extension. Load the generated directory, not this source directory.
4. Choose which browser handles each feature. A typical setup keeps Thread sync enabled in Chrome and Helium, with RALPH automation and Agent thread messaging enabled only in Chrome. Configure **Sub-agent project** once; the value is stored on the Local Codex server and shared by every executor browser.
5. Reload the generated extension after rerunning `pnpm support:prepare`.

Keep `.data` private. It contains the support-extension credential, thread bindings, RALPH state, and private RALPH audit logs.

## Sub-agents

`start_subagent` has one task input. It does not accept a project or conversation target. Before calling it, the parent agent must call `sync_current_thread` and then `get_current_thread_url`.

The server resolves the parent from `openai/session`, chooses the configured **Sub-agent project** or falls back to `https://chatgpt.com/`, and appends the parent callback instructions automatically. The child is told to report its final result with `send_thread_message` using the supplied parent conversation URL. The new child is registered for RALPH immediately and stores its parent thread ID.

`send_thread_message` accepts only an existing ChatGPT `/c/...` conversation URL. It cannot create a new conversation. `list_subagents` returns the children of the current synced parent and mounts a compact MCP App that shows their titles, state, RALPH mode, recent activity, and errors.

For a new child, the server sends an explicit new-thread target to the extension. The extension opens that target in a background tab and submits the task once; it does not own or resolve Sub-agent project configuration. A send is not retried after an ambiguous acknowledgement because duplicate prompts are worse than a failed attempt. Once ChatGPT saves the child conversation, the tool result returns to the parent and that creation tab closes normally.

Every fresh RALF registration then schedules `prepare_thread` in the browser that owns RALPH automation. This applies to normal allowlisted project threads, manually registered threads, and agent-created sub-agents. The RALPH browser opens the saved conversation in a background tab and parks it for up to two minutes. If the agent calls `sync_current_thread`, the successful binding handshake closes the parked tab immediately. Duplicate route observations, title updates, and ordinary reactivations do not open another initial sync tab.

## RALF behavior

RALF registration is independent from Thread Sync. The server keeps a project allowlist in `.data/ralph.json`. Normal project threads are retained only when their project is allowlisted. Manually registered threads and agent-created sub-agents remain registered regardless of that allowlist.

The extension reports the readable ChatGPT tab title during route updates, sends, and RALF inspections. The registry stores that title, and the popup uses it instead of a thread UUID when available.

The **RALPH threads** tab has Active and Completed views. An active row can be checked immediately, marked complete, or switched to **Run continuously**. A completed row can also be switched directly to continuous mode, which reactivates it. **Stop continuous** returns the thread to normal RALF behavior without marking it complete.

A normal RALF thread uses the existing duration gate. The first check defaults to 1500 seconds after registration or reactivation. A still-running thread is checked again after 300 seconds. When an idle thread reports a `Worked for ...` duration greater than **RALPH minimum worked time**, the server sends the compact transcript to the configured OpenAI classifier. `COMPLETE` marks the thread complete; otherwise RALF sends the classifier's short continuation instruction. Short or unavailable worked durations complete a normal thread without a classifier call.

Continuous mode is different and must be selected explicitly. When an idle continuous thread is due, RALF skips both the duration completion gate and the OpenAI completion classifier. It sends a fixed continuation instruction that tells the agent to reread the current state and execute the next useful improvement, experiment, verification, or cleanup toward the existing goal. The thread stays active until the user stops continuous mode or marks it complete.

RALF writes classification requests and results for normal mode to `<DATA_DIR>/ralph-openai.log`, which defaults to `.data/ralph-openai.log`. The API key is never written. Continuous-mode continuations do not call the classifier.

## Checks

`pnpm thread-sync-test` covers thread binding, the generated support extension, sub-agent callback injection, parent-child registration, title extraction, parked-tab release, continuous RALF behavior, project-scoped registration, duration gating, command claiming, and MCP App routing without starting a real browser or network listener.
