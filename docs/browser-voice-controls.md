# Control ChatGPT Voice from the local service

Use these commands to start and end Voice in a dedicated saved chat on chatgpt.com. This first step provides the control path for the Jarvis listener. Wake detection, task announcements, and Super App controls come later.

## Prepare the service and extension

Run these commands from the connector checkout:

```powershell
	pnpm install
	pnpm voice-test
	pnpm support:prepare
```

Restart the local service with its existing launch method after the build. In Chrome's extensions page, reload the generated `.data/support-extension`. Enable the designated automation executor and Thread messaging in Local Codex Support. Keep one automation browser profile connected.

Open a regular ChatGPT chat outside a project. Send a short setup message to save the conversation. Attach the computer connector for later tool use. Complete any microphone permission or Voice onboarding screens in Chrome.

Configure the chat with its saved URL:

```powershell
	pnpm agent voice configure https://chatgpt.com/c/YOUR_CONVERSATION_ID
```

The command returns the configured URL. The service saves that URL in `ralph.json` and excludes the chat from continuation and worker cleanup. Temporary chats and delegated worker chats cannot be configured.

## Start and end a call

Run:

```powershell
	pnpm agent voice status
	pnpm agent voice start
	pnpm agent voice stop
```

`status` returns `closed`, `active`, or `unavailable` with the conversation URL. These values describe the observed page controls. `active` does not prove that a spoken MCP request succeeded.

`start` activates the configured tab and clicks **Start Voice**. It opens the saved conversation if its tab is closed. A second start request leaves an active call active.

`stop` clicks **End Voice** and waits for **Start Voice** to return. It keeps the saved tab open. Ending a call does not stop delegated jobs or text generation. If the tab is already closed, `stop` returns `closed`.

The page has 30 seconds to confirm a state change. If a click fails, the command returns an error. Inspect the call controls before retrying. A failed stop never triggers a page refresh or closes the tab automatically.

If the conversation is open in multiple tabs, close the duplicate before controlling Voice. To change the configured chat, end its current call first. The service checks that the previous chat is closed before replacing its URL.

## Check failures

If `status` returns `unavailable`, check that Chrome is signed in, the chat has Voice access, and its controls have loaded. If `start` fails, inspect microphone permission and any onboarding prompt. Grant permission through Chrome's visible controls.

If the executor fails to connect, reload Local Codex Support in the automation profile and enable Thread messaging. The generated extension and running service must both include this change.

If an operation returns a conflict, wait for the current operation to finish. Voice requests use a separate polling path so worker automation pauses do not delay them.

The local CLI reads the existing extension token from the installation's data directory. Keep that token in the local process. The Voice API rejects browser-origin requests. Super App must call it from its main process.
