# Local Codex Support extension

This is the ChatGPT support extension for Local Codex. It is separate from `browser-extension/`, which is the general browser-control bridge. Install both only if you need both capabilities.

## Features

The popup exposes three independent toggles.

- **Thread sync** reports the exact ChatGPT conversation URL for the existing `sync_current_thread` and `get_current_thread_url` tools. It can be enabled in both Chrome and Helium.
- **RALF automation** lets the background RALF loop open registered conversations, wait through ChatGPT loading, detect the stop button, and extract the user messages plus final assistant response. Enable it only in the browser you want RALF to automate.
- **Agent thread messaging** lets the `chatgpt_message` MCP tool start a new ChatGPT/project thread or message an existing conversation. Enable it only in the browser you want agent-created automation to use.

The server atomically assigns each automation command to one enabled browser instance, so duplicate execution is prevented even if the same automation toggle is accidentally enabled in two browsers. Automation commands allow up to twenty minutes end to end, and the extension waits up to five minutes for the ChatGPT tab and composer to load before treating the attempt as failed.

## Install

1. Run `pnpm support:prepare`. This builds the project and writes the generated extension to `.data/support-extension` with its private loopback token and endpoints. Preparation also removes the obsolete generated `.data/thread-sync-extension` directory and migrates its private token if this is an upgrade.
2. Start or restart Local Codex. The support listener uses `http://127.0.0.1:6002` by default. `THREAD_SYNC_PORT` changes that port and `THREAD_SYNC_ENABLED=false` disables the support listener.
3. If the old **Local Codex Thread Sync** unpacked extension is still installed, remove it first. Then open the browser extensions page, enable Developer mode, choose **Load unpacked**, and select `.data/support-extension`. Load the generated directory, not this source directory.
4. Open the extension popup in each browser and choose which features that browser should handle. A typical setup is Thread sync on in both browsers, with RALF automation and Agent thread messaging on in only Chrome.
5. Reload the generated extension after rerunning `pnpm support:prepare`. Existing ChatGPT tabs are reinjected automatically when the extension starts.

Keep `.data` private. It contains the support extension credential, thread bindings, and RALF state.

## RALF behavior

A successful manual thread sync registers that conversation in `.data/ralf.json`. The first check is scheduled 25 minutes later.

When due, the server asks the enabled RALF browser to open the saved conversation in a background tab. The content script waits for the ChatGPT composer and conversation turns to settle. If `button[data-testid="stop-button"]` exists, the thread is treated as running and nothing else is read. If the page is still loading, the check is retried later.

For an idle thread, the extension returns every user message and only the final `[data-message-author-role="assistant"]` message. Tool cards, thinking UI, and other assistant-turn chrome are ignored. If there is no final assistant message, the extension returns a synthetic stopped message.

The server sends that compact transcript to the OpenAI Responses API using `RALF_MODEL`, which defaults to `gpt-5.6-terra`. Set `OPENAI_API_KEY` in the server environment. The model must answer exactly `COMPLETE` when the requested work is done, otherwise it returns a short one or two sentence next instruction. RALF sends that instruction back into the same thread and schedules the next check 25 minutes later.

Threads created or updated through `chatgpt_message` are recorded as exclusions and are not registered into the RALF loop later.

## Agent messaging

The `chatgpt_message` tool accepts a `targetUrl` and `message`. Supported targets are:

- `https://chatgpt.com/` for a new normal thread.
- A ChatGPT project `/g/.../project` URL for a new project thread.
- An exact `/c/<conversation-id>` URL to update an existing thread.

The selected browser opens the target in a background tab, waits for the composer, inserts the message with the same contenteditable path ChatGPT uses, clicks `#composer-submit-button`, waits for the send to be acknowledged, captures the saved conversation URL, reports it to Local Codex, and closes the automation tab.

## Checks

`pnpm thread-sync-test` covers thread binding, generated support-extension configuration, browser-neutral WebExtension behavior, RALF registration/exclusion, and atomic command claiming without starting a browser or network listener.
