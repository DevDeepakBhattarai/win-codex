# Agent instructions

Delegate reviews, browser work, and application testing through [the local delegation workflow](docs/delegation.md). You may also delegate a bounded part of a large task. Keep planning, implementation, diagnosis, reproduction, and evidence collection in the parent unless the user assigns that work to a worker.

In Codex, use the local CLI or HTTP API. The computer connector is for ChatGPT. Keep the parent turn active while the request waits. Read the returned report before continuing.

If you are an assigned ChatGPT worker, execute the specification yourself. Write the complete report to the supplied temporary path and rename it to the final report path. Publish observed failures and blockers. Then end your turn.

Use pnpm. Keep changes surgical, preserve precise types, and avoid `any`. Verify meaningful behavior and actual failure paths. Never claim an unperformed check passed.
