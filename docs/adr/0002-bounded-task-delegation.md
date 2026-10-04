# ADR 0002: blocking local delegation

This decision replaces the task handoff and parent notification flow. Explicit URL binding, browser ownership, authentication, and the command bus remain in use.

Local agents delegate through one CLI or authenticated loopback HTTP request. The request stays open until completion, cancellation, or startup failure. The parent keeps its turn active. HTTP keepalive whitespace preserves the response during long assignments. An interrupted client reconnects to the existing job.

The worker publishes its report through a temporary file and an atomic rename. The server watches for that file, validates it, persists the completed state, and returns the report. Startup scans recover reports published during downtime. A worker that stays idle without a report produces a BLOCKED outcome.

The ChatGPT computer connector has no task lifecycle tools. It retains explicit thread creation and messaging. Codex uses the local CLI or API, and the MCP endpoint rejects clients that identify themselves as Codex.

Automatic delegation applies to reviews, browser work, and application testing. Large tasks may delegate bounded independent assignments. Diagnosis, reproduction, and evidence collection stay in the parent unless the user assigns them to a worker.

The service owns dispatch, completion detection, and recovery state. The agent does not schedule wake-ups or poll job state.
