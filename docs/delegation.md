# Delegate a bounded assignment to ChatGPT

Use delegation for a review, browser work, or application testing. For a large task, you may delegate a small, independent assignment. Keep planning and implementation in the parent. Run diagnosis, reproduction, and evidence collection in the parent unless the user assigns them to a worker.

In Codex, use the installed local CLI or HTTP API. Never call this server's computer connector or its MCP tools from Codex, even if those tools are available. The connector's ChatGPT display name is `Codex`. Use native Codex tools for parent work. Only ChatGPT workers use the computer connector.

## Write and run the assignment

1. Write a specification file with the absolute workspace, revision, commands or URLs, expected results, permitted changes, and required report contents.
2. Run the CLI with a stable parent session and a unique request ID.

```powershell
	node D:/Coding/Experiments/local-windows-control-mcp/dist/cli.js run --file ABSOLUTE_SPEC_PATH --session PARENT_SESSION --request-id ASSIGNMENT_ID
```

3. Keep the parent turn active until the command returns. If the shell runner yields a session, wait on that same command. The CLI holds one HTTP request while the server watches for the worker's report. No heartbeat, scheduled wake-up, detached listener, or task status polling is required.
4. Read the returned JSON and the complete report. Evaluate observed results and blockers against the assignment. Implement confirmed fixes in the parent.

The CLI loads configuration from its installation directory, so you can run it from another workspace. The service opens a ChatGPT worker and supplies the completion path. Without a worker project, the service attaches the ChatGPT connector named `Codex`. Override its display name with `CHATGPT_WORKER_CONNECTOR_NAME`. This attachment belongs to the ChatGPT worker, not to the local parent.

## Finish as a worker

Execute the assigned specification yourself. Use the computer connector for terminal and browser access. Record the tested revision, expected and observed results, failures, evidence paths, and blockers.

Write the complete report to the temporary path supplied in the assignment. Rename that file to the supplied final report path. The rename signals completion. Publish a report even when a check fails or access is blocked. End your turn after publication. No task tool or conversation binding is required.

## Recover an interrupted connection

Use the job ID printed to stderr to wait for the existing assignment:

```powershell
	node D:/Coding/Experiments/local-windows-control-mcp/dist/cli.js wait JOB_ID
```

If the connection failed before a job ID arrived, repeat the same specification, session, and request ID. The service reuses the assignment without sending a second worker message.

A failed or uncertain startup returns `preparationError` and a nonzero CLI exit code. Inspect the saved job and worker before another assignment. The Support extension retains operator cancellation for abandoned jobs. A worker that stays idle without publishing a report receives a service-generated BLOCKED report.

A recovery wait returns a definite pre-send startup failure. It continues waiting after an uncertain send because the existing worker may still publish its report.

Remote callers need their own authenticated connection to this machine's loopback API. The CLI does not provide remote transport.
