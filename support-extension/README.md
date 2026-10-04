# Configure the Local Codex Support extension

Generate the private extension with `pnpm support:prepare`. Load `.data/support-extension` as an unpacked extension in Chrome. Do not load the source directory, which lacks the private endpoint token.

Enable **Thread sync**, **Automation browser executor**, and **Agent thread messaging** in your automation profile. Thread sync can also run in an observer browser. Enable the executor and messaging in the browser that owns automated ChatGPT work.

Set **ChatGPT worker project URL** to your existing ChatGPT project. Connect the refreshed MCP tools to that project. The default is the ChatGPT new-chat page.

After an update, reload the generated extension in `chrome://extensions` and reload ChatGPT pages. A running page can retain an older content script until navigation or reload.

Use **Tasks** to open worker conversations and inspect startup errors. Inspect uncertain delivery before cancelling an abandoned startup. A known worker must stop before cancellation releases the reservation.

Follow [the delegation workflow](../docs/delegation.md) for parent and worker prompts. Workers publish reports through the supplied temporary file and rename. The local request waits until the server collects the report. A final chat answer alone does not finish the job.

Automatic continuation is disabled by default. Legacy RALPH controls appear only when the server uses `RALPH_ENABLED=true`. Normal task delegation does not need that setting or an OpenAI API key.

For automatic Windows sign-in startup, build the project and run `scripts/install-startup.ps1`. Inspect `.data/runtime/watchdog.log` if the server or tunnel fails to start.
