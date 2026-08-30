# ADR 0001: explicit ChatGPT URL binding and support automation

## Status

Accepted on 2026-08-27. This replaces the earlier passive, project-scoped
mirroring design and now includes the separate Local Codex Support automation
features built on the same authenticated loopback extension.

## Context

ChatGPT supplies Local Codex with an opaque `openai/session`, while the browser
alone knows the conversation URL. Attaching sync UI to generic file or terminal
tools is unpredictable and can render irrelevant iframes. General browser
control is also a poor fit for narrow ChatGPT-specific operations that need a
known conversation URL, such as checking whether a thread is still running or
sending a message into a specific thread.

## Decision

Thread Sync keeps two narrow MCP tools:

- `sync_current_thread` attaches the visible MCP Apps component and initiates the
  extension handshake for the calling session.
- `get_current_thread_url` has no UI and returns only an existing binding. It
  never starts synchronization.

The Local Codex Support extension validates that the component belongs to the
current ChatGPT route and sends only the canonical conversation URL to the
loopback binding endpoint. Existing bindings are persisted and reused, while a
new observation of the same thread refreshes its stored ChatGPT route.

The same extension also owns two explicit automation features behind independent
browser toggles:

- RALPH owns a server-side allowlist of ChatGPT projects. The extension observes
  top-level ChatGPT project-conversation navigation and reports the canonical
  conversation URL to a dedicated RALPH registration endpoint. Thread Sync is not
  involved. RALPH later opens registered conversations in a background tab, waits
  for the page and conversation content to settle, treats the stop button as
  authoritative evidence that the thread is running, and otherwise returns the
  user messages plus the final assistant response for the server-side decision.
- `chatgpt_message` opens either an explicitly supplied ChatGPT target or, for a
  new sub-agent, the project URL configured in the enabled support extension. It
  verifies that ChatGPT did not redirect the automation tab elsewhere, sends the
  requested message, captures the saved conversation URL, and closes the
  automation tab. Existing conversation URLs remain valid explicit targets.

Automation commands are claimed by one enabled browser instance through the
authenticated loopback command bus. Thread sync may remain enabled in multiple
browsers because its binding request is idempotent, while the automation toggles
should normally be enabled only in the browser intended to execute those tasks.
The general browser-control extension remains separate.

## Consequences

Current-thread lookup still has a deterministic two-step protocol and generic
MCP tool calls never mount Thread Sync UI. The support extension now intentionally
reads ChatGPT conversation content only for RALPH inspection and performs narrowly
scoped ChatGPT tab automation only for RALPH and `chatgpt_message`.

RALPH registration is independent from current-thread lookup. Normal ChatGPT
project conversations are kept only when their project is explicitly configured
for RALPH. Named project-home paths are canonicalized to their stable project ID,
and removing a project removes those automatically observed threads. Threads
created by AI through `chatgpt_message` are registered for RALPH immediately and
remain registered even when their project is not in the normal RALPH allowlist.
The initial thread sync still requires an MCP client that renders the attached
Apps component and a locally installed Local Codex Support extension.
