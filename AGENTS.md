# Agent instructions

Delegate reviews, browser work, and application testing through [the local delegation workflow](docs/delegation.md). You may also delegate a bounded part of a large task. Keep planning, implementation, diagnosis, reproduction, and evidence collection in the parent unless the user assigns that work to a worker.

For an eligible assignment, read [the delegation workflow](docs/delegation.md), write a bounded specification, and run:

```powershell
	node D:/Coding/Experiments/local-windows-control-mcp/dist/cli.js run --file ABSOLUTE_SPEC_PATH
```

Keep the parent turn active until the command returns. If the shell runner yields a session, wait on that same command. Read the complete returned report before continuing. The CLI handles assignment identifiers and the service detects completion.

If your assignment supplies a report path, execute the specification yourself. Write the complete report to the supplied temporary path and rename it to the final report path. Include observed failures and blockers. Then end your turn.

Use pnpm. Keep changes surgical, preserve precise types, and avoid `any`. Verify meaningful behavior and actual failure paths. Never claim an unperformed check passed.
