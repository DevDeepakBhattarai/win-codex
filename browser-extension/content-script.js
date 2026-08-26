const MESSAGE_TARGET = "local-codex-control-overlay";
const HOST_ID = "__local-codex-control-overlay";

let host;
let pointer;
let pulse;
let clickCount = 0;

function mount() {
  if (host?.isConnected) return;

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
      .badge {
        align-items: center;
        background: rgba(21, 25, 35, 0.92);
        border: 1px solid rgba(125, 174, 255, 0.72);
        border-radius: 999px;
        box-shadow: 0 5px 18px rgba(26, 79, 170, 0.3);
        color: #fff;
        display: flex;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        gap: 7px;
        left: 50%;
        letter-spacing: 0.01em;
        padding: 7px 11px;
        position: fixed;
        top: 10px;
        transform: translateX(-50%);
      }
      .badge-dot {
        background: #73a7ff;
        border-radius: 50%;
        box-shadow: 0 0 8px #73a7ff;
        height: 7px;
        width: 7px;
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
      .pointer svg {
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
    <div class="badge"><span class="badge-dot"></span>Codex is controlling this tab</div>
    <div class="pointer">
      <svg viewBox="0 0 22 26" aria-hidden="true">
        <path d="M2 1.5v19.2l5.2-4.7 3.4 8.1 4.1-1.8-3.4-7.8h7.1L2 1.5Z" fill="#fff" stroke="#2f70dc" stroke-width="1.8" stroke-linejoin="round" />
      </svg>
      <div class="pulse"></div>
    </div>
  `;
  pointer = root.querySelector(".pointer");
  pulse = root.querySelector(".pulse");
  (document.documentElement ?? document).append(host);
}

function unmount() {
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
