# Agent instructions

For test execution, browser interaction, visual checks, or failure reproduction, read [the delegation workflow](docs/delegation.md) and hand the bounded specification to ChatGPT. Keep planning and implementation in the parent. End the parent turn after handoff. Do not poll for completion or execute the delegated checks yourself.

If the assignment identifies you as a ChatGPT worker with a job ID, execute it yourself and report through `task_done`. Do not recursively delegate. Report observed failures and blockers explicitly.

Use pnpm for this TypeScript repository. Keep changes surgical, preserve precise types, and avoid `any`. Verify meaningful behavior and actual failure paths. Never claim an unperformed check passed.
