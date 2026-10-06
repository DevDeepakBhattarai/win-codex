# Browser Voice through the local computer connector

Research date: October 5, 2026.

This design uses chatgpt.com in Chrome, this project's MCP server and extensions, and Super App at `D:/Coding/Experiments/super-app`. The installed Codex desktop application's Voice, pricing, and app-server protocol are outside the design.

## Feasibility

The proposed system is plausible. OpenAI announced plugin support in browser Live Voice on September 23, 2026. Support still varies by app, account, and available capabilities. This particular custom MCP connector needs a real Voice tool-call test before implementation can rely on it. [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes), [Plugin and app troubleshooting](https://help.openai.com/en/articles/20001497-troubleshooting-plugins-apps-in-chatgpt).

A delegated browser inspection found `button[aria-label="Start Voice"]` in the account's ordinary, unsent chatgpt.com composer. `Dictate` was a separate button. The account UI displayed Plus. The inspection did not start a call, capture audio, identify the in-call Voice mode, or invoke an MCP tool through Voice.

The [complete inspection report](../.data/tasks/002bd31b-708c-47d5-822a-3be63b7710b6.md) contains the observed DOM attributes and evidence paths. The [ordinary-composer screenshot](../.data/recordings/002bd31b-708c-47d5-822a-3be63b7710b6/0047817f-1b52-4089-8c9c-c77131554259.png) records the account-visible controls. These evidence files are local and ignored by Git.

## Existing code worth reusing

The GitHub repository is [DevDeepakBhattarai/computer-assistant](https://github.com/DevDeepakBhattarai/computer-assistant). GitHub main was `8a89d853bdd8c039c4f3cf0fe5f20233c7cbaa83` when inspected. The local checkout at `D:/Coding/computer-assistant` was `3ceae96ae4f805802f9cbb3307668d9b47e55bc4` with additional uncommitted changes. The remote and local implementations differ.

Both versions of `apps/wake-detector/src/index.ts` use Porcupine, `PvRecorder`, and a two-second trigger cooldown. GitHub's version detects Jarvis and Alexa. The local working version detects Jarvis and adds a Win+Space trigger and a POST to `/api/wake`. Both currently open a Next.js browser app after detection.

The reusable component is the local wake detector. Its browser-launch action can become an authenticated request to the MCP service's extension command bus. Its hardcoded recorder device index, access-key handling, shutdown, and native dependencies need validation during adaptation. Existing source is evidence of a useful starting point, not a successful microphone test. Porcupine's Node binding supports Windows and requires a Picovoice account and access key. [Porcupine Node documentation](https://picovoice.ai/docs/quick-start/porcupine-nodejs/).

`apps/web/hooks/use-speech.ts` already uses `speechSynthesis` for spoken text. Super App can use the same mechanism for short announcements, with a local voice selected explicitly. `SpeechSynthesisVoice.localService` identifies whether a voice is local. Electron voice availability still needs a runtime check. [Local speech voices](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService).

The local `apps/web/lib/computerUse.ts` also contains `getOpenWindows`, `focusWindow`, `captureScreenshot`, `mouseClick`, `keyboardType`, and `keyboardHotkey`. Those functions are candidates for exposing desktop control through this MCP server. Their current behavior, dependencies, and coordinate handling have not been tested in this project.

## Proposed operation

Super App owns the listener's lifecycle, the visible listening state, and a queue of task updates. The wake detector stays local while the ChatGPT Voice call is closed. The local service owns task state and the connection to Chrome. Chrome owns the actual ChatGPT call and its microphone permission.

The intended sequence is:

1. The local detector hears Jarvis and requests `voice_start` for a dedicated regular conversation.
2. The extension opens or selects that conversation and activates Start Voice.
3. The extension observes an active call before Super App plays a ready sound. The user can then speak a command without losing the command during connection startup.
4. Live calls the connected MCP tools. Those tools read task updates, send a reply to an identified task, or operate the computer.
5. A sleep command or an idle timeout requests `voice_stop`. The extension ends the call and confirms the stopped state. The wake detector remains available for the next request.

The inactivity policy should account for user speech and assistant playback. A starting policy is 60 seconds of conversational inactivity. This is a proposed product choice, not a ChatGPT limit. Long-running agents continue independently, and their later results enter the local announcement queue. Call teardown must not cancel the underlying agent jobs.

A dedicated saved conversation gives the service a stable URL and preserves context between calls. It avoids mixing spoken instructions with an unrelated chat. It does not need a new chat for every wake.

## Extension changes

`src/chatgpt-support.ts` already defines `SupportCommandBus`, command schemas, result schemas, executor selection, and target URLs. `support-extension/service-worker.js` already claims commands, routes them to tabs, and returns results. `support-extension/content-script.js` already dispatches page actions and observes DOM changes. `src/server.ts` registers the public MCP tools.

The first implementation adds `voice_status`, `voice_start`, and `voice_stop` command variants with precise result types. A separate `voice` polling path lets those commands run while worker automation is paused or busy. The extension enables that path alongside Thread messaging. Start and stop report an observed page-state transition, not merely a successful DOM click. [Browser Voice controls](browser-voice-controls.md).

The subsequent call inspection observed `button[aria-label="End Voice"]` and `button[aria-label="Turn off microphone"]`. A DOM click started Voice without an additional permission prompt. That run captured ambient speech before the worker could end the call, so it did not verify an explicit end-click or a second cycle. The existing `button[aria-label="Stop"]` stops text generation and cannot identify the Voice end control.

If a content-script click fails browser activation requirements, `src/browser.ts` already has CDP mouse input and `userGesture` support through the separate Browser Bridge extension. That provides an existing alternative to test. Neither path has passed a Voice-start experiment yet. Initial microphone permission still belongs to Chrome and chatgpt.com.

The saved Jarvis conversation must be excluded from RALPH registration, continuation, automatic refresh, and worker cleanup. Current completed-child cleanup checks `parentThreadId`, so Jarvis must never be registered as a worker child. An explicit exclusion by canonical conversation URL also prevents the ordinary activity observer from enrolling it in RALPH.

The listener should run under Super App or the local service, not solely inside the MV3 extension service worker. Chrome can unload a dormant service worker, and that worker cannot access the DOM. [Chrome extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers).

## Task updates across agents and applications

The current connector already persists delegated jobs and watches report files in `SubagentJobRegistry`. Its `complete` method means that a report exists, not that the assignment succeeded. The public `/agents` listing filters by caller session, and there is no public event subscription. The broader authenticated support state includes registered browser threads and jobs.

A small authenticated update endpoint can expose changes from the existing registry to Super App. It also needs input-request events and enough source identity to route a spoken reply. A task update should preserve the application, workspace, task identity, event identity, actual result, requested input, and artifact references. Deduplication prevents a hook and a Windows toast from announcing the same turn twice.

Codex CLI can run an external program through `notify` on `agent-turn-complete`. That payload includes the thread, turn, workspace, and last assistant message. `notify` alone does not cover permission requests. Supported Codex lifecycle hooks include `Stop`, `PermissionRequest`, and `SubagentStop`. [Codex notifications](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications), [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude Code supplies `Stop`, `SubagentStop`, `PermissionRequest`, and `Notification` hooks. Notification types include `permission_prompt` and `idle_prompt`. Stop payloads can contain the final assistant message. A stopped response or an idle prompt does not by itself establish that the user's task succeeded. Claude website and desktop conversations do not inherit Claude Code's hook system. [Claude Code hooks](https://code.claude.com/docs/en/hooks).

Windows `UserNotificationListener` can cover toast notifications from other applications. It requires user consent and a manifest capability. A small packaged Windows helper is a candidate integration for the current Electron app, which uses an NSIS installer. This requires a packaging feasibility check. It cannot capture an application's internal banner or a notification that the application never sends to Windows. Notification text alone may not identify the task or explain its changes. [Windows notification listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener).

Clear announcements use source facts. For example, an agent result containing the following facts could produce: "Claude finished the checkout task. It fixed the loading button, and the checkout checks passed. The preview is ready." An input request could produce: "ChatGPT needs your decision on the login change. Should it keep email login?" Unsupported details must not be inferred from a generic Done toast.

When Voice is closed, local speech handles these short alerts without opening a ChatGPT call. While Voice is active, updates can enter its chat as text if the account's in-call composer supports that path. Current documentation supports text during Live, but the extension's exact DOM path still needs testing. Messages need a bounded queue so several completions do not interrupt each other or consume a separate model turn for every event.

Spoken replies need a specific destination and request identity. "Tell Claude to keep email login" can route to the pending login request. A generic "yes" cannot choose between two pending questions. Announcing a request and submitting its answer are separate capabilities, and each agent's reply transport needs verification.

## Computer control through this MCP server

The existing `terminal`, file, process, and browser tools already cover many operations. Browser control does not provide pointer and keyboard control over arbitrary Windows applications.

Desktop screenshot, window focus, mouse, and keyboard tools can expose the useful `computer-assistant` functions through this connector. Structured task actions remain preferable for status and replies. Desktop control is useful when an application offers only a GUI. No OpenAI desktop-app plugin is required for that proposed MCP implementation.

Voice does not establish that every tool available in typed Chat is available in the call. A harmless read-only invocation is the first test. Screenshot output during Voice and a bounded desktop interaction are separate later tests.

## Browser limits and unresolved billing details

The current Chat Voice documentation lists Plus at three hours of GPT-Live-1 in a rolling 24-hour period. Pro 100 has 15 hours, and Pro 200 has unlimited GPT-Live-1. These browser allowances must not be replaced with desktop Voice pricing.

The current documentation does not establish a numeric maximum for a browser Live conversation or whether a muted idle call stops consuming allowance. It also states that connector actions requiring approval use on-screen controls. Spoken approval is unsupported. [ChatGPT Voice](https://help.openai.com/en/articles/20001274-chatgpt-voice).

Closing the call is therefore the correct implementation of the requested pause behavior. Local wake detection and local speech do not themselves use ChatGPT Voice minutes. Limits on the coding agents still apply independently. A future controlled usage experiment can record available quota before and after a short muted call, but a coarse meter cannot establish exact billing behavior.

## First prototype and evidence still required

The first prototype should contain only the reused Jarvis listener, a protected regular ChatGPT conversation, extension start and stop control, and one existing read-only MCP operation.

Success requires an observed Voice connection, a new server-side MCP invocation correlated with a spoken request, the correct response, and an observed end of microphone capture. It also requires a second wake to reopen Voice without creating another worker or disturbing a different call.

The meaningful failure checks are missing mic permission, absent Voice controls, unavailable Live or connector support, a rejected synthetic click, a disconnected extension, a closed Jarvis tab, expired login, rate limiting, duplicate wakes, and a stop control that leaves capture active. The next additions are task announcements and reply routing, followed by desktop tools. Existing jobs must remain intact when the call ends or the browser disconnects.

If the custom connector cannot run in this account's browser Live mode, that blocks the requested native-Voice design. A different subscription-based fallback could transcribe locally, submit typed messages through the existing extension, and speak the text responses locally. That fallback would need separate validation and would not be ChatGPT's live Voice experience.

## Phone visuals as phase two

An authenticated companion page can consume the same task updates and show screenshots, previews, and videos already saved with job reports. Its controls can refer to the same pending request identities used by voice. An iPhone and an Android phone can be candidate clients without changing phase one's laptop audio path.

The companion page needs HTTPS and paired access. The existing loopback bearer token belongs in the local process, not in the phone's JavaScript. Media should be served through authorized artifact identifiers, with formats tested on both phone browsers.

Screen Wake Lock can keep a visible page awake, but the browser or operating system can reject or release it. The page must display the actual wake-lock state and reacquire it after it becomes visible again. It cannot promise indefinite operation while hidden or locked. [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).

## Inspection scope

The connector checkout was `da859f5d135d8785393b3009f402d7e21a13bac3`. Super App was `adca83d6ea4031a501dfd73d4b1985153a5fd05e` with uncommitted changes. Research preserved the existing source in both projects and in computer-assistant.

Validation consisted of source inspection, GitHub file inspection, current documentation, and delegated browser DOM inspection. Live audio, wake detection, voice-tool execution, notification capture, desktop control, and phone playback were not run. The installed desktop CLI schema investigation was superseded by the user's explicit browser-only requirement and is not evidence for this design.
