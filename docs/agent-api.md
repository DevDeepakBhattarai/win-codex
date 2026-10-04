# Run a ChatGPT worker from a local agent

Build and start the server. Enable **Agent thread messaging** and **Automation browser executor** in the Support extension. Sign in to ChatGPT in that browser. Attach the computer connector to the ChatGPT worker project if you use one.

Run one bounded assignment:

```powershell
	pnpm agent run --file spec.md --session parent-001 --request-id review-001
```

Keep the command alive until it returns the worker report. Follow [the delegation workflow](delegation.md) for assignment and recovery steps. Use the CLI from Codex. The computer connector belongs to ChatGPT.

After a server update, restart the server and reload the generated Support and Browser Bridge extensions in `chrome://extensions`. Reload the ChatGPT page to replace an older content script.
