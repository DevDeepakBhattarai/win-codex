const MESSAGE_TARGET = "local-codex-control-overlay";
const overlay = createLocalCodexControlOverlay({
  cursorUrl: chrome.runtime.getURL("cursor.svg"),
  emptyFaviconUrl: chrome.runtime.getURL("empty.svg"),
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== MESSAGE_TARGET) return;
  try {
    switch (message.command) {
      case "show":
        overlay.show();
        break;
      case "hide":
        overlay.hide();
        break;
      case "move":
        overlay.move(message.x, message.y);
        break;
      case "click":
        overlay.click();
        break;
      default:
        throw new Error(`Unknown control overlay command: ${message.command}`);
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
