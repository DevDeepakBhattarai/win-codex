# Run the nightly PR tester

Run commands from `D:\Coding\Experiments\local-windows-control-mcp`.

To inspect the installed scheduler, run:

```powershell
pnpm exec node scripts/nightly-pr-control.mjs status
```

To preview the current open PR list and the first PR's full prompt without creating a conversation, run:

```powershell
pnpm exec node scripts/nightly-pr-control.mjs preview
```

Edit `.data/nightly-pr/config.json` to change the repository, workspace, time zone, hour, concurrency, or enabled state. Rebuild after code changes and restart the connector after configuration changes.

To request a scheduler tick through the authenticated local endpoint, run:

```powershell
pnpm exec node scripts/nightly-pr-control.mjs tick
```

A tick respects the configured start date and daily hour. It does not force an early run. The connector checks every minute. If the machine starts after 2 a.m., it runs that day's check when the connector starts checking. Windows must be running under your signed-in account. The startup shortcut does not wake a sleeping or powered-off machine.

To close conversations created by prior nightly runs, run `pnpm exec node scripts/nightly-pr-control.mjs dismiss-started`. It stops their RALPH checks and closes automation-owned tabs. It leaves jobs that have never started in the queue. An unchanged dismissed PR stays dismissed; a new commit can start a new run.

Inspect `.data/nightly-pr/state.json` for the queue and conversation URLs. Open `.data/nightly-pr/jobs/<job-id>/prompt.md` to read the exact prompt sent to a task. Each task writes its checkpoint, evidence, and `result.json` in that directory. The prompt generator is `buildPrompt` in `src/nightly-pr.ts`.

The scheduler creates ChatGPT conversations through the existing support extension and registers them in normal RALPH mode. Keep that extension enabled and signed in, and keep the connector's existing HTTPS tunnel available for ChatGPT tool calls. Normal RALPH honors explicit `RALPH_STATUS` checkpoints and uses its completion classifier when a settled turn has run longer than 20 minutes. The two-task limit applies to nightly tasks, not to unrelated conversations already running.

Successful PRs are skipped while their head and base commits remain unchanged. Blocked jobs resume in the same conversation on the next daily check. Active jobs retain their reservation across restarts. A completion report requires local evidence and a fresh GitHub check. Every reported GitHub check must pass. Missing, pending, failed, skipped, and cancelled checks prevent completion.

If a job is `uncertain`, inspect ChatGPT before recovery. A send may have succeeded even when the connector lost its response. Stop the connector before editing its state file. After confirming the exact conversation and that no turn is running, set that job's `conversationUrl` and `state` to `blocked`. Restart the connector. The next daily scan resumes that conversation. If you confirm that no conversation was created, set `state` to `queued` without a conversation URL. Never clear the reservation merely because delivery timed out.

To disable future scans, set `enabled` to `false` and restart the connector. Stop existing nightly conversations through the support extension if you also want to stop their RALPH loops. The separate connector startup shortcut is `Local Computer Control MCP.lnk`. Removing it stops the full connector from starting at sign-in, including MCP, browser control, and RALPH. The watchdog logs connector output under `.data/connector-startup/` and restarts an exited connector. It leaves an existing listener alone.

To verify scheduler changes, run:

```powershell
pnpm type
pnpm build
pnpm exec node --test scripts/nightly-pr-test.mjs
```

The tests exercise the scheduler with a simulated thread transport. They do not prove that a live ChatGPT session can use the connector or that any PR passes its browser tests. Read each task's evidence before relying on its result.
