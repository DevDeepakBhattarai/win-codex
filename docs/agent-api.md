# Call a ChatGPT browser agent from Claude

Start the server with `pnpm build` followed by `pnpm start`. Enable **Agent thread messaging** and **Thread preparation executor** in the Local Codex Support extension. Sign in to ChatGPT in that browser and connect this server's MCP tools to the configured Sub-agent project. The child uses the existing ChatGPT conversation and result tools.

After updating, restart the server and reload **Local Codex Browser Bridge** in `chrome://extensions`. The server refreshes the generated extension under `.data/browser-extension` at startup. Install FFmpeg on PATH, or set `FFMPEG_PATH`, to record videos.

Run these commands in the repository directory. If the server uses another `DATA_DIR` or `THREAD_SYNC_PORT`, use those values.

```powershell
	$agentToken = (Get-Content .data/support-extension-token -Raw).Trim()
	$agentHeaders = @{ Authorization = "Bearer $agentToken" }
	$agentBody = @{
		prompt = "Test http://localhost:3000. Submit an empty login form, verify validation, and record the test."
		session = "claude"
		requestId = [guid]::NewGuid().ToString()
	} | ConvertTo-Json
	$job = Invoke-RestMethod http://127.0.0.1:6002/agents -Method Post -Headers $agentHeaders -ContentType application/json -Body $agentBody
	Invoke-RestMethod "http://127.0.0.1:6002/agents/$($job.jobId)" -Headers $agentHeaders
```

Reuse the same `requestId`, `session`, and prompt if the POST response is lost. A changed prompt needs a new request ID. Deduplication lasts while the job remains in the local registry.

Read the job again after a reasonable delay, such as five seconds. Stop polling when `state` becomes `complete` or `cancelled`. On completion, `result` contains the report, and `videos` and `screenshots` contain absolute local file paths. A pending job with `preparationError` needs attention. If it also has `childConversationUrl`, open that conversation to inspect the child. Do not start another copy after uncertain delivery.

Use `POST /agents/JOB_ID/cancel` with the same header to cancel. Cancellation stops a known child before releasing its slot. If Stop cannot be confirmed, the API returns 409 and keeps the job pending.

To use the optional CLI instead, run:

```powershell
	pnpm agent start --prompt "Test http://localhost:3000 and record the test" --request-id test-001
	pnpm agent status JOB_ID
	pnpm agent list
	pnpm agent cancel JOB_ID
```

Use `--file prompt.txt` for a longer prompt. Run the CLI from the repository, or set `DATA_DIR` to the server's absolute data directory. The CLI reads the local token and calls the same API.

Give Claude the following instruction, with the repository path filled in:

```text
When I ask you to delegate browser testing, call the local ChatGPT agent API.
Read the token from REPOSITORY/.data/support-extension-token without displaying it.
POST http://127.0.0.1:6002/agents with Authorization: Bearer TOKEN and JSON containing
prompt, session, and requestId. Use one stable session for this task and a new
requestId for each assignment. Reuse that requestId if you retry the POST.
Include the exact URL, test steps, and expected results in prompt.
Keep the returned jobId. GET /agents/JOB_ID at intervals of at least five seconds.
Read result when state is complete and inspect the videos and screenshots paths.
Report preparationError instead of silently starting another agent.
Cancel an abandoned job with POST /agents/JOB_ID/cancel.
```

Claude must run on this computer, or already have a way to call its loopback service and read its files. This setup requires no cloud service or Claude API key.
