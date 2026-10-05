# Configure the Local Codex Support extension

Generate the private extension with `pnpm support:prepare`. Load `.data/support-extension` as an unpacked extension in Chrome. Do not load the source directory, which lacks the private endpoint token.

Enable **Thread sync**, **Automation browser executor**, and **Task and thread messaging** in your automation profile. Thread sync can also run in an observer browser. Enable the executor and messaging in the browser that owns automated ChatGPT work.

Keep **Recover interrupted chats** enabled in Helium and Chrome to resume failed turns in their existing tabs. This switch is enabled by default and does not require the executor, task messaging, Thread sync, or RALPH. Disable it in a browser if you want to handle that browser's errors yourself.

Enable **Check unfinished chats** in Helium and Chrome to register ordinary chats for RALPH completion checks. Keep the executor enabled only in Chrome. The default interval is 1800 seconds, or 30 minutes. For an idle chat, the service sends all readable user messages and the final assistant response to the API classifier. A COMPLETE decision settles the chat. A CONTINUE decision sends a continuation in Chrome after Chrome confirms that the conversation is idle. Running and loading chats wait for another check. Delegated workers keep their report-based recovery, and the dedicated Voice chat is excluded. Stream-error recovery remains independent of this switch.

Workers start in temporary chats and use the configured worker plugin. Their tabs close after the service collects the report.

After an update, reload the generated extension in `chrome://extensions`. Reload saved ChatGPT pages after their work finishes. Keep temporary task chats open without refreshing. A running page can retain an older content script until the extension injects its current version.

Click the extension's toolbar button to open the sidebar. **Threads** shows active chats and workers. **Working** and **Tasks** open by default. Use **Inspect** to open a worker's existing temporary chat or **Cancel task** to stop it. Completed chats appear in the separate **Settled** tab. Send a new message in a chat to reactivate it. The sidebar has no continuous-run mode.

To schedule a prompt, open **Schedules**, enter the prompt, and choose a date and time. For recurring work, enable **Repeat** and choose an interval in minutes, hours, or days. Click **Schedule task**. The date and time use the browser's local time zone. Each occurrence starts a new temporary chat with the configured worker plugin. Keep the server running at the scheduled time. Enable **Automation browser executor** and **Task and thread messaging** in Chrome. Use **Cancel schedule** before a one-time run starts. Use **Stop repeating** to cancel future occurrences. A prompt already being sent can finish delivery. Use **Open chat** to inspect the latest delivered occurrence. **Started** confirms prompt delivery, not task completion.

Schedules survive restarts. The server skips times missed while it was off and retains the next future occurrence of a repeating schedule. A provider cooldown delays a pending task until automation resumes. Repeats keep their original cadence and skip elapsed intervals without sending a burst of missed prompts. If delivery fails or the server stops during delivery, inspect ChatGPT before sending the prompt again. The server does not retry an uncertain occurrence. Future occurrences of a repeating schedule continue until you stop it.

Settlements retry after a server outage. The registry discards settled history when it needs space for a new thread.

Inspect uncertain delivery before cancelling an abandoned startup. A known worker must stop before cancellation releases the reservation.

Follow [the delegation workflow](../docs/delegation.md) for parent and worker prompts. Workers publish reports through the supplied temporary file and rename. The local request waits until the server collects the report. A final chat answer alone does not finish the job.

Set **RALPH check interval** to change the default 1800-second worker recovery interval. The service resumes an idle worker until its report arrives. Marked manual-thread continuation uses the separate **RALPH automation** switch and server setting. Worker recovery needs no OpenAI API key. Ordinary RALPH completion decisions require `OPENAI_API_KEY`. The classifier returns `COMPLETE` or `CONTINUE`. Unfinished work receives a fixed continuation message, and explicit engineering checkpoints retain their existing behavior.

When an open chat displays a connection-interrupted notice or a response error, the extension clicks Stop, waits for the turn to stop, and sends a continuation in the same chat. Helium chats stay in Helium, and Chrome chats stay in Chrome. An idle failed turn also receives a continuation. Rate-limit notices wait ten minutes before dismissal and continuation. Temporary chats never reload during recovery. Recovery preserves your unsent draft and ignores unrelated upload errors.

Before an action, recovery reserves the chat through the server. A queued message or a Voice configuration already in progress prevents that recovery action. When recovery holds the chat, a new server message or Voice configuration fails before delivery. Retry after recovery finishes. A message's owning browser can recover for that message without adding a continuation. The reservation lasts at most nine minutes, and an expired browser action cannot click Stop or Send. An uncertain browser response retains the reservation until that deadline. The configured Voice conversation remains protected. Recovery does not send when it cannot check the server's current status.

When an empty conversation displays **Could not load this ChatGPT conversation**, browser automation pauses globally for five minutes. Checks, recovery clicks, refreshes, sends, and automatic tab closure wait. Queued commands and task state stay intact. Local report collection continues. The pause deadline survives service and extension restarts. Automation resumes after the deadline and retries the visible page action. The sidebar displays the pause and resumption time.

For automatic Windows sign-in startup, build the project and run `scripts/install-startup.ps1`. Inspect `.data/runtime/watchdog.log` if the server or tunnel fails to start.
