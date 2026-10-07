# Control ChatGPT Voice from the local service

Use Super App's Jarvis or Nova wake word, the local CLI, or the agent's `chatgpt_voice` tool to control Voice in Chrome.

## Prepare the service and extension

Run these commands from the connector checkout:

```powershell
	pnpm install
	pnpm voice-test
	pnpm support:prepare
```

Restart the local service with its existing launch method after the build. In Chrome's extensions page, reload the generated `.data/support-extension`. Enable the designated automation executor and Thread messaging in Local Codex Support. Keep one automation browser profile connected.

Complete microphone permission and Voice onboarding in Chrome. In Super App, turn on **Listen for Jarvis or Nova**.

To designate an already-open saved chat before its first call, configure its URL:

```powershell
	pnpm agent voice configure https://chatgpt.com/c/YOUR_CONVERSATION_ID
```

Configuration is optional. It checks the tab through the extension before saving its URL. It does not make the service reopen a closed tab. Temporary chats, project chats, delegated worker chats, and duplicate tabs cannot be configured.

## Start and end a call

Run:

```powershell
	pnpm agent voice status
	pnpm agent voice start
	pnpm agent voice mute
	pnpm agent voice unmute
	pnpm agent voice stop
```

`status` returns `closed`, `active`, `loading`, or `unavailable`, the observed conversation URL, and the microphone state when controls exist. A fresh chat reports `https://chatgpt.com/` until ChatGPT saves its conversation. `active` does not prove that a spoken MCP request succeeded.

`start` selects an active Voice call first. Otherwise, it selects the tracked Voice tab if that tab is still open. If no Voice tab remains, it opens a fresh regular chat. A saved URL alone does not cause the service to reopen a closed tab. If Voice is active, `start` unmutes its microphone. If Voice is closed, `start` starts it.

`mute` and `unmute` change the microphone without ending the call. A wake word or **Start Voice** also unmutes an active call.

Voice automatically mutes after 4.5 seconds of user silence. It also mutes after 1.5 seconds of user silence when the assistant has spoken continuously for 1.5 seconds. User speech resets the silence timer. Playback gaps under 300 milliseconds do not restart the assistant timer.

The extension measures local input energy and received WebRTC audio energy. It sends only activity flags between the page scripts. Missing input measurements do not count as silence. For a call opened before the monitor was installed, the extension uses a separate local input monitor and releases that monitor when the call ends.

`stop` clicks **End Voice** and waits for **Start Voice** to return. It keeps the saved tab open. Ending a call does not stop delegated jobs or text generation. If the tab is already closed, `stop` returns `closed`.

The page has 30 seconds to confirm a state change. If a wake sees Voice controls stuck in loading for eight seconds, the extension refreshes that same tab once and retries startup. A startup that remains stuck after its click also gets one refresh. A second failure reports an error.

Missing controls during text generation, login failures, and microphone permission failures do not trigger a refresh. A failed stop leaves the tab available for the next wake to recover.

If multiple active calls exist, end the extra call before retrying. To change the configured chat, end its current call first. The service checks that the previous chat is closed before replacing its URL. The selected tab and its saved URL are protected from worker continuation, page recovery, and cleanup.

## Let the agent end its call

Refresh the computer connector's tools in ChatGPT after updating the service. Attach the connector to your Voice chat. Ask the agent to disconnect with `chatgpt_voice` and `action: "stop"`. Use `status` to inspect the call, `start` to resume Voice, or `mute` and `unmute` to change the microphone.

After disconnecting, say "Jarvis" or "Nova" with Super App listening enabled to reconnect. You can also click **Start Voice** in Super App. The disconnected ChatGPT call cannot hear your request.

Auto-mute leaves the call connected and keeps your Voice speaker selected. Super App restores your previous Windows outputs after the call ends. Turn listening off to release the local wake microphone.

## Check failures

If `status` returns `unavailable`, check that Chrome is signed in, the chat has Voice access, and its controls have loaded. If `start` fails, inspect microphone permission and any onboarding prompt. Grant permission through Chrome's visible controls.

If the executor fails to connect, reload Local Codex Support in the automation profile and enable Thread messaging. The generated extension and running service must both include this change.

If an operation returns a conflict, wait for the current operation to finish. Voice requests use a separate polling path so worker automation pauses do not delay them.

The local CLI reads the existing extension token from the installation's data directory. Keep that token in the local process. The Voice API rejects browser-origin requests. Super App must call it from its main process.
