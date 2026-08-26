const MESSAGE_TARGET = "local-codex-control-overlay";
const HOST_ID = "__local-codex-control-overlay";
const CONTROL_FAVICON = chrome.runtime.getURL("cursor.svg");
const EMPTY_FAVICON = chrome.runtime.getURL("empty.svg");
const FAVICON_ATTRIBUTES = { href: CONTROL_FAVICON, type: "image/svg+xml", sizes: "any" };
const originalFavicons = new Map();
let controlFavicon;
const faviconObserver = new MutationObserver(updateFavicon);

let host;
let pointer;
let pulse;
let clickCount = 0;

function updateFavicon() {
  faviconObserver.disconnect();
  if (document.head) {
    for (const link of document.querySelectorAll('link[rel~="icon"]')) {
      if (link === controlFavicon) continue;
      const original = originalFavicons.get(link) ?? {};
      for (const [attribute, value] of Object.entries(FAVICON_ATTRIBUTES)) {
        const current = link.getAttribute(attribute);
        if (!(attribute in original) || current !== value) original[attribute] = current;
        if (current !== value) link.setAttribute(attribute, value);
      }
      originalFavicons.set(link, original);
    }
    if (!controlFavicon) {
      controlFavicon = document.createElement("link");
      controlFavicon.rel = "icon";
    }
    for (const [attribute, value] of Object.entries(FAVICON_ATTRIBUTES)) {
      if (controlFavicon.getAttribute(attribute) !== value) controlFavicon.setAttribute(attribute, value);
    }
    if (document.head.lastElementChild !== controlFavicon) document.head.append(controlFavicon);
  }
  faviconObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["rel", ...Object.keys(FAVICON_ATTRIBUTES)],
  });
}

function restoreFavicon() {
  // Capture site changes that have not reached the observer yet.
  updateFavicon();
  faviconObserver.disconnect();
  controlFavicon?.remove();
  for (const [link, original] of originalFavicons) {
    for (const [attribute, value] of Object.entries(original)) {
      if (value === null) link.removeAttribute(attribute);
      else link.setAttribute(attribute, value);
    }
  }
  originalFavicons.clear();
  if (controlFavicon && !document.querySelector('link[rel~="icon"]')) {
    // Removing the only icon link leaves Chrome showing its last cached icon.
    const fallback = controlFavicon;
    fallback.href = EMPTY_FAVICON;
    document.head?.append(fallback);
    const defaultIcon = new Image();
    defaultIcon.onload = () => {
      if (fallback.isConnected && fallback.getAttribute("href") === EMPTY_FAVICON) {
        fallback.href = defaultIcon.src;
        fallback.removeAttribute("type");
        fallback.removeAttribute("sizes");
      }
    };
    defaultIcon.src = new URL("/favicon.ico", location.href).href;
  }
  controlFavicon = undefined;
}

function mount() {
  if (host?.isConnected) return;

  updateFavicon();

  host = document.createElement("div");
  host.id = HOST_ID;
  host.dataset.localCodexControl = "true";
  host.setAttribute("aria-hidden", "true");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host {
        all: initial;
        contain: strict;
        display: block;
        inset: 0;
        pointer-events: none !important;
        position: fixed;
        z-index: 2147483647;
      }
      .aura {
        border: 3px solid rgba(66, 133, 244, 0.9);
        box-shadow:
          inset 0 0 22px rgba(66, 133, 244, 0.28),
          inset 0 0 5px rgba(255, 255, 255, 0.75);
        box-sizing: border-box;
        inset: 0;
        position: fixed;
        animation: codex-aura 2.4s ease-in-out infinite;
      }
      .pointer {
        filter: drop-shadow(0 2px 5px rgba(9, 40, 95, 0.6));
        height: 26px;
        left: 0;
        position: fixed;
        top: 0;
        transform: translate3d(50vw, 50vh, 0);
        transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
        width: 22px;
        will-change: transform;
      }
      .pointer img {
        display: block;
        height: 100%;
        overflow: visible;
        width: 100%;
      }
      .pulse {
        border: 2px solid rgba(98, 155, 255, 0.95);
        border-radius: 50%;
        height: 24px;
        left: -12px;
        opacity: 0;
        position: absolute;
        top: -12px;
        width: 24px;
      }
      @keyframes codex-aura {
        0%, 100% { border-color: rgba(66, 133, 244, 0.72); }
        50% { border-color: rgba(117, 169, 255, 1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .aura { animation: none; }
        .pointer { transition-duration: 0ms; }
      }
    </style>
    <div class="aura"></div>
    <div class="pointer">
      <img src="${CONTROL_FAVICON}" alt="">
      <div class="pulse"></div>
    </div>
  `;
  pointer = root.querySelector(".pointer");
  pulse = root.querySelector(".pulse");
  (document.documentElement ?? document).append(host);
}

function unmount() {
  if (host || controlFavicon) restoreFavicon();
  host?.remove();
  host = undefined;
  pointer = undefined;
  pulse = undefined;
  clickCount = 0;
}

function move(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  mount();
  host.dataset.pointerX = String(x);
  host.dataset.pointerY = String(y);
  pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function click() {
  mount();
  clickCount += 1;
  host.dataset.clickCount = String(clickCount);
  pointer.animate(
    [
      { filter: "drop-shadow(0 2px 5px rgba(9, 40, 95, 0.6))" },
      { filter: "drop-shadow(0 0 10px rgba(86, 148, 255, 1))" },
      { filter: "drop-shadow(0 2px 5px rgba(9, 40, 95, 0.6))" },
    ],
    { duration: 260, easing: "ease-out" },
  );
  pulse.animate(
    [
      { opacity: 0.95, transform: "scale(0.35)" },
      { opacity: 0, transform: "scale(1.7)" },
    ],
    { duration: 420, easing: "ease-out" },
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== MESSAGE_TARGET) return;
  try {
    switch (message.command) {
      case "show":
        mount();
        break;
      case "hide":
        unmount();
        break;
      case "move":
        move(message.x, message.y);
        break;
      case "click":
        click();
        break;
      default:
        throw new Error(`Unknown control overlay command: ${message.command}`);
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
