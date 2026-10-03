# ADR 0002: bounded ChatGPT task delegation

This decision replaces the reviewer-only handoff and default automatic continuation described in ADR 0001. Explicit URL binding, tab ownership, authentication, and the existing command bus remain in use.

Parents write specifications and implement changes. ChatGPT workers execute a bounded specification for tests, browser work, visual checks, or reproduction. `start_task`, `list_tasks`, and `task_done` replace the reviewer tools. `start_thread` remains an explicitly requested standalone conversation with no callback.

Completion requires an explicit report. Specifications and reports live in `.data/tasks` with an atomic job registry. Legacy review and subagent stores migrate on first open. Duplicate completion preserves the first report. Uncertain startup preserves the reservation. Uncertain notification requires operator inspection before retry.

ChatGPT parents end their turn and receive a service message after worker completion and idle. Local agents use one CLI process with bounded HTTP waits. A custom runner must persist its parent session and resume it on completion. An indefinitely held MCP call is not the resume mechanism.

The service detects workers that stay idle without submitting a report and records a BLOCKED outcome. It does not call a model or restart the worker. Automatic RALPH continuation is disabled by default. `RALPH_ENABLED=true` retains the legacy runtime as an explicit opt-in.

Windows sign-in starts a hidden supervisor. The supervisor reuses a healthy server and the configured Cloudflare tunnel, logs failures, and restarts exited processes. It does not replace the user's ChatGPT login or silently refresh connector permissions.
