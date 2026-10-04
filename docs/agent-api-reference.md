# Local agent API

The support listener exposes `/agents` on `127.0.0.1`, at `THREAD_SYNC_PORT`, default 6002. Requests require `Authorization: Bearer TOKEN`. The token is in `<DATA_DIR>/support-extension-token`. Requests with an Origin header receive 401. `THREAD_SYNC_ENABLED=false` disables this listener.

| Request | Response |
| --- | --- |
| `POST /agents` | One held response until a report, cancellation, or startup error |
| `GET /agents/JOB_ID/wait` | One held response for the existing assignment |
| `GET /agents/JOB_ID` | Current job, report, and saved video and screenshot paths |
| `GET /agents?session=local` | Jobs for the session, default `local` |

`POST /agents` accepts these JSON fields:

| Field | Meaning |
| --- | --- |
| `prompt` | Required specification, 1 to 180000 characters after trimming |
| `session` | Caller grouping, default `local`. Letters, numbers, underscores, and hyphens, up to 100 characters |
| `requestId` | Required retry identifier, 1 to 100 characters, scoped to the session |

The held response has HTTP status 200 and an `X-Job-Id` header. JSON whitespace keeps the connection alive every 15 seconds. The response body ends with one JSON object. Client disconnection releases that request's listener while the worker continues. A repeated request ID with the same prompt reuses the assignment. A different prompt returns 409.

Each session has at most two pending assignments. Capacity returns 429. Malformed input returns 400. Unknown local jobs return 404. Sessions group jobs within one trusted local caller and are not separate authentication identities.

The CLI supplies `session` from `--session`, `CODEX_THREAD_ID`, or `CODEX_SESSION_ID`, in that order. Without those values, it uses `local-` followed by a hash of the canonical current workspace directory. Windows directory names are case-insensitive for this hash. The CLI generates `requestId` unless `--request-id` is supplied. These identifiers require no conversation binding or callback to the caller.

A job has `jobId`, `state`, `resultPath`, `createdAt`, and `parentThreadId`. New assignments have `specPath`. Local parents use `api:SESSION`. Confirmed startup adds `childThreadId` and `childConversationUrl`. Failed or uncertain startup sets `preparationError`. Interrupted startup remains reserved across restarts and is never resent automatically.

`deliveryUncertain` is false when startup failed before dispatch or the executor confirmed that it did not send the task. A recovery wait returns that saved failure. Unknown delivery remains reserved, and recovery waits for a report or operator cancellation.

`state` is `pending`, `complete`, or `cancelled`. Result responses add `result`, `videos`, and `screenshots`. `result` is null until completion. The worker publishes a nonempty report of at most 200000 characters by renaming its temporary file to `resultPath`. The service watches the directory and persists completion. Startup scans collect reports published while the service was stopped. An idle worker without a report receives a service-generated BLOCKED report.

Complete means that a report is available, not that checks passed. No parent notification or callback is sent. Cancellation is an operator action in the Support extension. The computer MCP connector rejects clients that identify themselves as Codex.
