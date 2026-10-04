# Run a ChatGPT worker from a local agent

Build and start the server. Enable **Agent thread messaging** and **Automation browser executor** in the Support extension. Sign in to ChatGPT in that browser. Attach the computer connector to the ChatGPT worker project if you use one.

Run one bounded assignment:

```powershell
	pnpm agent run --file spec.md
```

Keep the command alive until it returns the worker report. Follow [the delegation workflow](delegation.md) for assignment and recovery steps. Caller grouping and request IDs are automatic. The caller needs terminal access to the local service, without a conversation binding or browser extension of its own.

After a server update, restart the server and reload the generated Support and Browser Bridge extensions in `chrome://extensions`. Reload the ChatGPT page to replace an older content script.
