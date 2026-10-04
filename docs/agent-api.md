# Run a ChatGPT worker from a local agent

Build and start the server. Enable **Task and thread messaging** and **Automation browser executor** in the Support extension. Sign in to ChatGPT in that browser. The service starts temporary worker chats and attaches the configured worker plugin.

Run one bounded assignment:

```powershell
	pnpm agent run --file spec.md
```

Keep the command alive until it returns the worker report. Follow [the delegation workflow](delegation.md) for assignment and recovery steps. Caller grouping and request IDs are automatic. The caller needs terminal access to the local service, without a conversation binding or browser extension of its own.

After a server update, restart the server and reload the generated Support and Browser Bridge extensions in `chrome://extensions`. Reload the ChatGPT page to replace an older content script.
