# ADR 0001: explicit ChatGPT URL binding

## Status

Accepted on 2026-08-27. This replaces the earlier passive, project-scoped
mirroring design.

## Context

ChatGPT supplies Local Codex with an opaque `openai/session`, while the browser
alone knows the conversation URL. Attaching sync UI to generic file or terminal
tools is unpredictable and can render irrelevant iframes. Automatically opening
or mirroring Chrome tabs gives a URL-binding feature responsibilities it does
not need.

## Decision

Thread Sync exposes two narrow tools:

- `sync_current_thread` attaches the visible MCP Apps component and initiates the
  extension handshake for the calling session.
- `get_current_thread_url` has no UI and returns only an existing binding. It
  never starts synchronization.

The extension validates that the component belongs to the current ChatGPT route
and sends only the canonical conversation URL to the loopback binding endpoint.
It injects into existing ChatGPT tabs on installation, reload, and browser startup. It
reads only the matching ChatGPT tab URL needed for binding and does not read chat
content, mirror conversations, or perform browser automation.

Code that needs to interact with a bound conversation must obtain its URL and
then use the existing browser tools explicitly.

## Consequences

The agent has a clear two-step protocol and generic tool calls never mount Thread
Sync UI. Exact URL lookup is fast and deterministic after binding. The initial
sync still requires an MCP client that renders the attached Apps component and a
locally installed Thread Sync extension.
