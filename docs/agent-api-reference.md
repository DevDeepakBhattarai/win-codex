# Local agent API

The support listener exposes `/agents` on `127.0.0.1`, at `THREAD_SYNC_PORT`, default 6002. The API requires `Authorization: Bearer TOKEN`, using the token in `<DATA_DIR>/support-extension-token`. Requests with an Origin header are rejected. `THREAD_SYNC_ENABLED=false` disables this listener and API.

| Request | Response |
| --- | --- |
| `POST /agents` | 202 with a persistent job, before browser startup completes |
| `GET /agents?session=claude` | Jobs for the given session, default `claude` |
| `GET /agents/JOB_ID` | Job, report text, and saved video and screenshot paths |
| `GET /agents/JOB_ID/wait?timeoutMs=25000` | Same response after completion, cancellation, startup error, or timeout. The range is 1 to 50000 milliseconds |
| `POST /agents/JOB_ID/cancel` | Job after confirmed cancellation, or 409 on failure |

`POST /agents` accepts these JSON fields:

| Field | Meaning |
| --- | --- |
| `prompt` | Required task text, 1 to 180,000 characters after trimming |
| `session` | Optional caller grouping, default `claude`. Letters, numbers, underscores, and hyphens, up to 100 characters |
| `requestId` | Optional retry identifier, up to 100 characters, scoped to the session |

Each session has at most two pending jobs. Capacity returns 429. Reusing a request ID with a different prompt returns 409. Malformed input returns 400, missing authentication returns 401, and an unknown API job returns 404. Sessions group jobs within one trusted local caller. They are not separate authentication identities.

A job has `jobId`, `state`, `resultPath`, `createdAt`, and `parentThreadId`. New assignments also have `specPath`. API parents use `api:SESSION` and have no ChatGPT parent URL. A confirmed startup adds `childThreadId` and `childConversationUrl`. `preparationError` records failed or uncertain startup. An interrupted startup stays pending across restarts and is never resent automatically. Unknown child URLs require manual inspection before cancellation.

`state` is `pending`, `complete`, or `cancelled`. Both status and wait responses add `result`, `videos`, and `screenshots`. `result` is null until completion. The worker stores its report with `task_done`. A service-generated BLOCKED report can also complete a stopped worker. Complete means a report is available, not that tests passed. API jobs never send a ChatGPT parent notification.

## Browser tools added for testing

| Tool | Behavior |
| --- | --- |
| `browser_recording` | Start, stop, or inspect a tab recording. Optional `jobId` groups the file with an API job |
| `browser_screenshot` | Return a native PNG image and save its path. Accepts `fullPage` or `clip`, plus optional `jobId` |
| `browser_viewport` | Set width and height for responsive testing. Omit both to reset |
| `browser_dialog` | Get, accept, or dismiss JavaScript dialogs. Accepts prompt text |
| `browser_action` | Adds `hover`, coordinate-path `drag`, native `select` with option values, and `check` with a boolean state |

Video uses Chrome DevTools screencast frames and FFmpeg to encode a silent 1280 by 720 WebM at 10 frames per second. Aspect ratio is preserved with padding. It records the tab viewport, including pauses, for up to 30 minutes. It does not record the desktop, browser toolbar, audio, or other tabs. Each tested tab needs its own recording. Background-tab updates depend on Chrome's rendering and throttling.

Files live in `<DATA_DIR>/recordings/JOB_ID`, or `manual` when no job is supplied. A completed encoding receives a `.webm` name. Incomplete encodings keep `.partial.webm` and are excluded from `videos`. A JSON sidecar contains timing, frame count, and encoding errors. Tab release, tab closure, debugger detachment, bridge disconnect, and graceful server shutdown finalize active recordings. Abrupt process termination can leave partial files.

## Codex capability comparison

The comparison uses the installed Codex Browser API reference and [official Browser documentation](https://learn.chatgpt.com/docs/browser).

The extension has tab management, fresh element references, Playwright-style selectors, accessibility snapshots, native screenshot images, keyboard and pointer actions, uploads, downloads, JavaScript evaluation, and console and network diagnostics. This change adds the tools above and a prompt-driven API around existing ChatGPT threads.

This extension does not reproduce Codex's complete Playwright object API, cross-origin frame locators, clipboard API, browsing history, WebMCP discovery, Workspace document exports, page asset bundles, or in-app annotations. Those remain outside this browser-testing change. Existing tab ownership and authentication checks remain active.
