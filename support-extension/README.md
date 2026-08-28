# Local Codex Support extension

This is the ChatGPT support extension for Local Codex. It is separate from `browser-extension/`, which is the general browser-control bridge. Install both only if you need both capabilities.

## Features

The popup has two tabs. **RALF threads** lists every thread the server has registered for the loop, with its project, state, last continuation, and next scheduled check; each row opens the conversation in a new tab. **Settings** holds three independent toggles plus the sub-agent project, RALF timing, and RALF project allowlist.

The thread list is read from the server, so it is identical in every browser running the extension.

- **Thread sync** reports the exact ChatGPT conversation URL for the existing `sync_current_thread` and `get_current_thread_url` tools. It can be enabled in both Chrome and Helium.
- **RALF automation** lets the background RALF loop open registered conversations, wait through ChatGPT loading, detect the stop button, and extract the user messages plus final assistant response. Enable it only in the browser you want RALF to automate.
- **Agent thread messaging** lets the `chatgpt_message` MCP tool start a new ChatGPT/project thread or message an existing conversation. Enable it only in the browser you want agent-created automation to use.

The server atomically assigns each automation command to one enabled browser instance, so duplicate execution is prevented even if the same automation toggle is accidentally enabled in two browsers. Automation commands allow up to twenty minutes end to end, and the extension waits up to five minutes for the ChatGPT tab and composer to load before treating the attempt as failed.

## Install

1. Run `pnpm support:prepare`. This builds the project and writes the generated extension to `.data/support-extension` with its private loopback token and endpoints. Preparation also removes the obsolete generated `.data/thread-sync-extension` directory and migrates its private token if this is an upgrade.
2. Start or restart Local Codex. The support listener uses `http://127.0.0.1:6002` by default. `THREAD_SYNC_PORT` changes that port and `THREAD_SYNC_ENABLED=false` disables the support listener.
3. If the old **Local Codex Thread Sync** unpacked extension is still installed, remove it first. Then open the browser extensions page, enable Developer mode, choose **Load unpacked**, and select `.data/support-extension`. Load the generated directory, not this source directory.
4. Open the extension popup in each browser and choose which features that browser should handle. A typical setup is Thread sync on in both browsers, with RALF automation and Agent thread messaging on in only Chrome. Set **Sub-agent project** in the browser that handles Agent thread messaging. Configure **RALF projects** and **RALF loop interval** from either browser. The server stores both settings and shares them with every support-extension instance. **RALF minimum worked time** remains local to each browser.
5. Reload the generated extension after rerunning `pnpm support:prepare`. Existing ChatGPT tabs are reinjected automatically when the extension starts.

Keep `.data` private. It contains the support extension credential, thread bindings, and RALF state.

## RALF behavior

RALF does not use Thread Sync for registration. The server keeps an explicit project allowlist in `.data/ralf.json`. Paste one project home URL or project ID per line into **RALF projects** in the extension popup. Project home URLs may include ChatGPT's display-name suffix, for example `/g/g-p-<id>-deepak/project`; Local Codex stores the stable `g-p-<id>` portion.

The **RALF threads** tab reads `/chatgpt-support/ralf/threads` and has separate Active and Completed views. A thread shows `retrying` when its last check failed, and the recorded error appears on the row. Use **Mark complete** to stop future checks manually. Use **Mark active** on a completed thread to schedule a fresh check using the configured loop interval.

When a ChatGPT tab navigates to `/g/<project-id>/c/<thread-id>`, the support extension reports that URL to the RALF registration endpoint. The server registers it only when the project is allowlisted. This works for normal ChatGPT navigation and for project threads spawned by `chatgpt_message`. Removing a project from the allowlist removes its registered RALF threads.

**RALF loop interval** controls the delay before checking a newly registered thread and before checking an active thread again. It defaults to 1500 seconds (25 minutes). The server persists this setting in `.data/ralf.json`, and saving a new value reschedules every active thread from the current time.

When due, the server asks the enabled RALF browser to open the saved conversation in a background tab. The content script waits for the ChatGPT composer and conversation DOM to become stable instead of trusting the browser load event alone. Running threads are detected by `button[data-testid="stop-button"]`; idle assistant turns must remain stable for 5 seconds, while an uncertain user-only state is given 15 seconds for late hydration before it can be treated as stopped. Once idle, the content script reads the latest assistant turn's `Worked for ...` label. **RALF minimum worked time** controls this duration gate and defaults to 1140 seconds (19 minutes). RALF calls OpenAI only when the parsed duration is greater than the saved threshold; shorter or missing durations end the RALF entry without an API call.

For an idle thread, the extension returns every user message and only the final `[data-message-author-role="assistant"]` message. Tool cards, thinking UI, and other assistant-turn chrome are ignored. If there is no final assistant message, the extension returns a synthetic stopped message. Empty extracted text is an inspection failure, so RALF keeps the thread active and reports the error instead of asking OpenAI to classify an empty transcript.

The server sends that compact transcript to the OpenAI Responses API using `RALF_MODEL`, which defaults to `gpt-5.6-terra`. Set `OPENAI_API_KEY` in the server environment. RALF requests low reasoning effort and does not set `max_output_tokens`. The model must answer exactly `COMPLETE` when the requested work is done, otherwise it returns a short one or two sentence next instruction. RALF sends that instruction back into the same thread and schedules the next check using the configured loop interval.

The server appends every classification request and result to `<DATA_DIR>/ralf-openai.log`, which defaults to `.data/ralf-openai.log`, as one JSON object per line. Successful result records contain the extracted `response_text`, not the raw Responses payload or encrypted reasoning item. They also include the OpenAI request ID, HTTP status, duration, token usage, and selected action. Failed requests retain the error response body for diagnosis. No record contains the API key. Treat this log as private because it contains conversation text. RALF persists the request record before it calls OpenAI and skips the API call if the file cannot be written.

## Agent messaging

The `chatgpt_message` tool always accepts a `message`. For a new sub-agent, omit `targetUrl`; the enabled browser opens the **Sub-agent project** configured in the extension popup. To update an existing thread, pass its exact `/c/<conversation-id>` URL as `targetUrl`. An explicit ChatGPT project `/g/.../project` URL is still accepted as an override.

Bare `https://chatgpt.com/` new-thread targets are rejected so agent-created sub-agents cannot escape the project organization.

The selected browser opens the target in a background tab and waits before inserting anything. Existing conversations must expose an actual human message node, then keep the complete turn DOM and composer stable for 5 seconds. An assistant message is not required because a thread may stop before producing one. A new-chat page has no prior messages, so it must keep its composer stable for 3 seconds instead. After insertion, the extension also requires an enabled send control to remain stable before clicking. Each send attempt is capped at 30 seconds; one retry is allowed only when the exact message is still in the composer and the conversation has not advanced, which avoids duplicating a send that may actually have reached ChatGPT. A successful send must expose the stop button, and the extension keeps the tab open for another 2 seconds before capturing the saved conversation URL, reporting it to Local Codex, and closing the automation tab.

## Checks

`pnpm thread-sync-test` covers thread binding, generated support-extension configuration, browser-neutral WebExtension behavior, project-scoped RALF registration, AI-created project-thread registration, duration gating, and atomic command claiming without starting a browser or network listener.
