# Delegate execution to ChatGPT

Use this workflow as a parent agent when a task requires test execution, browser interaction, visual checks, or failure reproduction. Keep specification, implementation, and evaluation in the parent. A ChatGPT worker executes one bounded specification.

Without a worker project, the service creates a default chat and attaches the connector named `Codex` through the composer menu. Set `CHATGPT_WORKER_CONNECTOR_NAME` to the display name of your connector if it differs. Missing connector access stops the handoff before Send.

If your assignment identifies you as a ChatGPT worker and includes a job ID, execute the assignment yourself. Report through `task_done`. Do not delegate again.

## Write the assignment

Write a specification file with the absolute workspace, revision, target URLs, commands or reproduction steps, expected results, allowed changes, and required evidence. Define when the worker must stop. Permit a blocker report when access or information is missing. Require observed results for every requested check. Request recordings only when needed.

Include the revision and a unique assignment identifier. A changed revision needs a new assignment. Do not send an open-ended instruction to keep working until the project is complete.

## Hand off from ChatGPT

Use this server's `sync_current_thread` before the first handoff. If it reports syncing, finish with `get_current_thread_url`.

Call `start_task` with the specification in `prompt`. Keep the returned job ID, conversation URL, and report path. End the parent turn immediately. The service sends the parent a report notification after the worker submits `task_done` and becomes idle. Do not poll `list_tasks` or start another copy.

Use `start_thread` only when the user explicitly asks for a separate conversation. It creates no job or callback.

## Hand off from a local agent

The CLI loads configuration from its installation directory, so you can call it from another workspace. Use one stable session ID for the parent and a unique request ID for the assignment.

```powershell
	node D:/Coding/Experiments/local-windows-control-mcp/dist/cli.js run --file ABSOLUTE_SPEC_PATH --session PARENT_SESSION --request-id ASSIGNMENT_ID
```

Start that command using your agent runner's native background-task facility if it provides a completion notification. End the parent turn after dispatch. The CLI remains alive and reconnects to bounded HTTP waits without model calls. When the command exits, read its JSON report and evidence files.

If your runner returns a shell session without a completion notification, save the session and job ID. That runner needs an external resume integration to wake an ended turn. Do not assume that a shell session or an indefinitely held MCP call can resume every Codex or Claude client. For a custom runner, persist the parent session with the job ID, await `/agents/JOB_ID/wait` outside the model, and resume the saved session after a terminal result.

If the CLI disconnects, resume the same job with `node D:/Coding/Experiments/local-windows-control-mcp/dist/cli.js wait JOB_ID`. Do not create a replacement assignment. The CLI prints the job ID and resume command to stderr. Reuse the same request ID and specification if the initial response was lost.

Remote agents need an existing connection to this machine's authenticated loopback API and evidence files. This CLI does not add a remote transport.

## Handle a report or a failed handoff

Read the complete report. Compare observed results against the specification. Treat a blocker, a failed check, or a missing report as incomplete validation. Implement fixes in the parent, then delegate any further execution with a new specification.

If startup is uncertain, inspect the existing job and conversation. Resolve the reservation in the Support extension before another handoff. If parent notification is uncertain, inspect the parent conversation before selecting **Retry parent wake-up**. A retry can duplicate a message that already reached ChatGPT.

The service stores specifications, reports, job IDs, errors, and notification attempts under `.data/tasks`. A worker that remains idle for two minutes without `task_done` receives a service-generated BLOCKED report. The service checks browser state without model calls and never automatically continues that worker.
