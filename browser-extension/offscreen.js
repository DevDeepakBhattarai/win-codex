chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return undefined;
  void handleClipboardRequest(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});

async function handleClipboardRequest(message) {
  switch (message.method) {
    case "clipboard.readText":
      return { text: await readText() };
    case "clipboard.writeText":
      if (typeof message.params?.text !== "string") throw new Error("Clipboard text is required.");
      await writeText(message.params.text);
      return {};
    default:
      throw new Error(`Unsupported offscreen request: ${message.method}`);
  }
}

async function readText() {
  try {
    return await navigator.clipboard.readText();
  } catch (error) {
    if (!isFocusError(error)) throw error;
    const textarea = document.querySelector("#clipboard");
    textarea.value = "";
    textarea.focus();
    if (!document.execCommand("paste")) throw new Error("Chrome refused clipboard paste in the offscreen document.");
    return textarea.value;
  }
}

async function writeText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    if (!isFocusError(error)) throw error;
    const textarea = document.querySelector("#clipboard");
    textarea.value = text;
    textarea.focus();
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Chrome refused clipboard copy in the offscreen document.");
  }
}

function isFocusError(error) {
  return error instanceof Error && /not focused/i.test(error.message);
}
