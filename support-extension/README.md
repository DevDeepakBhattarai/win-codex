# Configure the Local Codex Support extension

Generate the private extension with `pnpm support:prepare`. Load `.data/support-extension` as an unpacked extension in Chrome. Do not load the source directory, which lacks the private endpoint token.

Enable **Thread sync**, **Automation browser executor**, and **Agent thread messaging** in your automation profile. Thread sync can also run in an observer browser. Enable the executor and messaging in the browser that owns automated ChatGPT work.

Workers start in temporary chats and use the configured worker plugin. Their tabs close after the service collects the report.

After an update, reload the generated extension in `chrome://extensions`. Reload saved ChatGPT pages after their work finishes. Keep temporary task chats open without refreshing. A running page can retain an older content script until the extension injects its current version.

Open the extension popup and click **Sidebar** to keep the thread list beside your browser. The popup remains available. **Ready for you** lists finished manual threads with recent completions first. **Working** groups running threads. **Tasks** groups active workers and offers **Inspect** and **Cancel task**. Finished tasks leave the list. After you view a finished manual thread and move away, or close its tab, the thread moves to **Settled**. Running and blocked threads keep their active status.

Settlements retry after a server outage. The registry discards settled history when it needs space for a new thread.

Inspect uncertain delivery before cancelling an abandoned startup. A known worker must stop before cancellation releases the reservation.

Follow [the delegation workflow](../docs/delegation.md) for parent and worker prompts. Workers publish reports through the supplied temporary file and rename. The local request waits until the server collects the report. A final chat answer alone does not finish the job.

Set **RALPH check interval** to change the default 1800-second worker recovery interval. The service resumes an idle worker until its report arrives. Marked manual-thread continuation uses the separate **RALPH automation** switch and server setting. Worker recovery needs no OpenAI API key.

When a managed temporary chat displays the connection-interrupted notice, the extension checks three times, 30 seconds apart, then stops and resumes a stuck turn. It does not refresh temporary chats because that discards their conversation. Saved managed threads refresh at each check. A recovered stream continues without a Stop or another message.

For automatic Windows sign-in startup, build the project and run `scripts/install-startup.ps1`. Inspect `.data/runtime/watchdog.log` if the server or tunnel fails to start.
