# Run a ChatGPT execution task from a local agent

Build and start the server. Enable **Agent thread messaging** and **Automation browser executor** in the Local Codex Support extension. Sign in to ChatGPT in that browser. Connect this server's refreshed MCP tools to the configured ChatGPT worker project.

After updating, restart the server and reload the generated Local Codex Support extension and Local Codex Browser Bridge in `chrome://extensions`. Reload the ChatGPT page to replace an older content script.

Write a specification with the workspace, revision, commands or URLs, steps, expected results, allowed changes, and evidence requirements. Follow [the delegation workflow](delegation.md) for parent and worker instructions.

Run the CLI in this repository:

```powershell
	pnpm agent run --file spec.md --session parent-001 --request-id check-001
```

The command dispatches once, prints its job ID to stderr, and waits for the report. It makes no model calls while waiting. Use your agent runner's native completion notification to resume the parent when the command exits. An arbitrary shell session does not guarantee a wake-up in every client.

If the wait disconnects, resume the job:

```powershell
	pnpm agent wait JOB_ID
```

For inspection or recovery, use these commands:

```powershell
	pnpm agent status JOB_ID
	pnpm agent list --session parent-001
	pnpm agent cancel JOB_ID
```

Inspect uncertain startup before cancellation. Cancellation stops a known worker before releasing its reservation. A failed stop preserves the pending job.

To dispatch without a CLI wait, use `POST /agents`. To wait from an integration, use `GET /agents/JOB_ID/wait`. See [the API reference](agent-api-reference.md) for authentication and responses. Preserve the session and request ID across retries. Never submit another task solely because a wait expired.
