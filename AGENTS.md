# Agent instructions

Delegate reviews, browser work, and application testing through [the local delegation workflow](docs/delegation.md). You may also delegate a bounded part of a large task. Keep planning, implementation, diagnosis, reproduction, and evidence collection in the parent unless the user assigns that work to a worker.

In Codex, never call this server's computer connector or its MCP tools, even if they appear in the available tools. Its ChatGPT display name is `Codex`. Use your native Codex tools for parent work and the local CLI or HTTP API for delegation. The computer connector belongs only to ChatGPT workers.

For an eligible assignment, read [the delegation workflow](docs/delegation.md), write a bounded specification, and run:

```powershell
	node D:/Coding/Experiments/local-windows-control-mcp/dist/cli.js run --file ABSOLUTE_SPEC_PATH --session PARENT_SESSION --request-id ASSIGNMENT_ID
```

Keep the parent turn active until the command returns. If the shell runner yields a session, wait on that same command. The server waits for the worker's report. Do not end the parent turn after dispatch, poll task status, or schedule a wake-up. Read the complete returned report before continuing.

If you are an assigned ChatGPT worker, execute the specification yourself. Write the complete report to the supplied temporary path and rename it to the final report path. Publish observed failures and blockers. Then end your turn.

Use pnpm. Keep changes surgical, preserve precise types, and avoid `any`. Verify meaningful behavior and actual failure paths. Never claim an unperformed check passed.
