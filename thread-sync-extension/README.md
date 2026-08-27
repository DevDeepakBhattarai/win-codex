# ChatGPT thread sync

This extension links the `openai/session` received by Local Codex to the exact
URL of the ChatGPT conversation that invoked it. It reports only that URL. It
does not inspect chat text, mirror conversations, or control browser pages. It reads only the matching ChatGPT tab URL needed for binding.

## Install

1. Run `pnpm thread-sync:prepare`. This builds the project and prepares
   `.data/thread-sync-extension` with its private loopback configuration.
2. Start or restart Local Codex normally. Thread sync is enabled by default.
   `THREAD_SYNC_ENABLED=false` disables it. `THREAD_SYNC_PORT` changes its
   loopback listener from the default `http://127.0.0.1:6002`.
3. Open the browser's extensions page, enable Developer mode, choose **Load
   unpacked**, and select `.data/thread-sync-extension`. Do not load this source
   directory.
4. Refresh or rescan Local Codex's tool definitions in ChatGPT after changing
   the server tools.

The extension injects its content script into existing ChatGPT tabs as soon as
it is installed, reloaded, or started. New matching tabs receive the script
through the manifest. A normal sync should not require refreshing the page.

Keep `.data` private. It contains the extension credential, pending tickets,
and session-to-URL bindings.

## Use

1. Always call `sync_current_thread` first. Its visible MCP Apps component passes
   a private binding ticket to the extension. This is safe to call again if the
   conversation was already synced.
2. Immediately call `get_current_thread_url`. It waits briefly for the visible UI and extension
   handshake and returns the stored URL. This is the only tool that should be
   used to obtain the current thread URL.
3. The agent must not infer the URL or use browser-control tools as a fallback.

Calling `get_current_thread_url` without first mounting the sync UI returns an error that
asks the agent to run the two-step sequence again. Duplicate reports of the same
mapping are accepted. Conflicting session or URL mappings are rejected.
Bindings persist in `.data/thread-sync.json`; pending tickets expire after 30
minutes.

## Troubleshooting

- **The sync tool never completes:** confirm the generated extension is loaded
  and enabled for `https://chatgpt.com/*`, and that ChatGPT supports the attached
  MCP Apps resource.
- **The lookup says the conversation is not synced:** call
  `sync_current_thread`, wait for its tool result, then retry the lookup. The
  extension sends the URL as soon as the visible component supplies its ticket.
- **The extension cannot reach the server:** compare its generated bind URL with
  the server's `Thread sync endpoint` log. Do not expose this listener through a
  tunnel. If the configured port is occupied, change `THREAD_SYNC_PORT`, rerun
  `pnpm thread-sync:prepare`, and reload the extension.
- **An extension update is not active:** rerun `pnpm thread-sync:prepare` and
  reload the generated unpacked extension. Its startup injection updates
  already-open ChatGPT tabs.
- **Missing session:** the MCP client did not supply `openai/session`. Thread
  Sync does not guess a URL or issue a ticket.

## Checks

`pnpm thread-sync-test` exercises the registry, an in-memory MCP transport, the
visible widget bridge, current-route validation, existing-tab reinjection,
concurrent sessions, persistence, authentication, expiration, CSP, and browser
Fetch port blocking. It starts no listener or browser.

The implementation follows the documented [MCP Apps UI bridge](https://developers.openai.com/plugins/build/chatgpt-ui)
and [tool-result metadata](https://developers.openai.com/plugins/reference#tool-results).
