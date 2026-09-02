# ADR 0001: explicit ChatGPT URL binding and support automation

## Status

Accepted on 2026-08-27 and extended on 2026-09-01 with first-class sub-agent tools, parent-child tracking, readable thread titles, and explicit continuous RALF mode.

## Context

ChatGPT gives Local Codex an opaque `openai/session`, while the browser knows the conversation URL. Thread sync must therefore cross the MCP Apps UI and the support extension. ChatGPT-specific automation also needs a narrow path that does not depend on the general browser-control extension.

Sub-agents are separate ChatGPT conversations. They do not have an implicit return channel to the parent, and new sub-agent threads should stay in a dedicated ChatGPT project instead of cluttering the user's working project.

## Decision

Thread Sync keeps two narrow MCP tools:

- `sync_current_thread` mounts the Thread Sync MCP App and starts the extension handshake for the calling session.
- `get_current_thread_url` reads the resulting binding. It never infers or constructs a URL.

Delegation uses three MCP tools:

- `start_subagent` requires the parent conversation to be freshly synced. It creates the child in the **Sub-agent project** configured on the Local Codex server, falling back to `https://chatgpt.com/` when no dedicated project is configured. The server reads the parent URL from the calling `openai/session`, adds that URL to the child prompt, and tells the child to report back with `send_thread_message`.
- `send_thread_message` posts only to an existing `/c/...` conversation. It cannot create a new thread.
- `list_subagents` returns the children created by the current parent and renders the sub-agent MCP App.

The server stores the parent thread ID on agent-created RALF entries. A new child is registered for RALF immediately even when its project is not in the normal RALF project allowlist.

A fresh RALF registration schedules a `prepare_thread` command on the browser that owns RALPH automation. This applies to normal allowlisted project threads, manually registered threads, and agent-created sub-agents. The RALPH browser opens the saved conversation in a background tab and parks it for up to two minutes. A successful `sync_current_thread` handshake releases that tab early. Duplicate observations and reactivations do not schedule another initial sync tab. Sub-agent creation no longer owns a separate parking path.

The extension also reports the readable ChatGPT tab title. RALF stores the title and refreshes it during later inspections, so operator UIs do not need to identify threads by UUID alone.

RALF has two independent concepts:

- `state` is `active` or `complete`.
- `mode` is `normal` or `continuous`.

Normal mode keeps the existing duration gate and completion classifier. Continuous mode is explicit per thread. When an idle continuous thread is due, RALF skips the completion classifier and sends a fixed continuation instruction that tells the agent to keep advancing the existing goal. Continuous mode never starts automatically.

The server resolves every sub-agent target before enqueueing automation; browser extensions are execution workers and do not own sub-agent routing configuration. Automation commands are claimed atomically by one enabled browser instance through the authenticated loopback command bus. Thread sync may stay enabled in multiple browsers because binding is idempotent. RALF and agent messaging should normally be enabled only in the browser intended to execute those commands.

## Consequences

The root model no longer has to remember callback plumbing when it delegates. It only has to follow the required sync sequence before `start_subagent`. The server supplies the correct parent URL and callback instruction.

RALF remains runtime support rather than the engineering orchestrator. Normal work can stop when it is actually complete. An indefinite run exists only after the user explicitly selects **Run continuously**.

The engineering workflow belongs in the `engineering-loop` skill. That skill routes bugs through `diagnosing-bugs`, uses independent reviewer sub-agents for substantial changes, reverifies fixes, and hands finished work to `git-commit` and `file-pr` when publishing is requested.
