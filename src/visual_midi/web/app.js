const titleNode = document.querySelector("#app-title");
const layoutRoot = document.querySelector("#layout-root");
const qrPanel = document.querySelector("#qr-panel");
const qrLink = document.querySelector("#qr-link");
const qrImage = document.querySelector("#qr-image");

let currentVersion = null;

function shouldHideQrPanel() {
  return new URLSearchParams(window.location.search).has("noqr");
}

function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  if (shouldHideQrPanel()) {
    url.searchParams.set("noqr", "1");
  }
  return url.toString();
}

async function fetchConfig() {
  const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Config request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchVersion() {
  const response = await fetch("/api/version", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Version request failed: ${response.status}`);
  }
  return response.json();
}

function renderLayout(node) {
  if (node.type === "slider") {
    return renderSlider(node);
  }

  const group = document.createElement("section");
  group.className = `layout-group layout-group--${node.type}`;
  applyNodeSizing(group, node);
  for (const child of node.children) {
    group.appendChild(renderLayout(child));
  }
  return group;
}

function renderSlider(node) {
  const wrapper = document.createElement("article");
  wrapper.className = `control control--${node.orientation}`;
  applyNodeSizing(wrapper, node);

  const header = document.createElement("div");
  header.className = "control-header";

  const label = document.createElement("label");
  label.className = "control-label";
  label.htmlFor = node.key;
  label.textContent = node.label;

  const meta = document.createElement("div");
  meta.className = "control-meta";
  meta.textContent = `CH ${node.channel}  CC ${node.control}`;

  header.append(label, meta);

  const input = document.createElement("input");
  input.className = "control-slider";
  input.id = node.key;
  input.type = "range";
  input.min = String(node.min);
  input.max = String(node.max);
  input.step = "1";
  input.value = String(node.value);
  input.style.setProperty("--accent", node.color || "#d26a2e");
  if (node.orientation === "vertical") {
    input.classList.add("control-slider--vertical");
  }

  input.addEventListener("input", async () => {
    const value = Number(input.value);
    label.textContent = `${node.name}: ${value}`;
    try {
      await fetch("/api/slider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: node.key, value }),
      });
    } catch (_error) {
    }
  });

  wrapper.append(header, input);
  return wrapper;
}

function applyNodeSizing(element, node) {
  if (node.width) {
    element.dataset.width = node.width;
    element.style.setProperty("--node-width", node.width);
  }
  if (node.height) {
    element.dataset.height = node.height;
    element.style.setProperty("--node-height", node.height);
  }
}

function applyQrPanel(payload) {
  if (!payload.showQrPanel || shouldHideQrPanel()) {
    qrPanel.classList.add("qr-panel--hidden");
    return;
  }

  qrPanel.classList.remove("qr-panel--hidden");
  qrLink.href = payload.qr.url;
  qrLink.textContent = payload.qr.url;
  qrImage.src = payload.qr.image;
  qrImage.alt = `QR code for ${payload.qr.url}`;
}

async function loadApp() {
  const payload = await fetchConfig();
  currentVersion = payload.version;
  document.title = payload.title;
  titleNode.textContent = payload.title;
  layoutRoot.replaceChildren(renderLayout(payload.layout));
  applyQrPanel(payload);
  scheduleVersionPolling(payload.reloadPollMs);
}

let pollTimer = null;

function scheduleVersionPolling(intervalMs) {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
  }

  pollTimer = window.setInterval(async () => {
    try {
      const payload = await fetchVersion();
      if (payload.version !== currentVersion) {
        await loadApp();
      }
    } catch (_error) {
    }
  }, intervalMs);
}

loadApp().catch((error) => {
  layoutRoot.innerHTML = `<p class="error-state">${error.message}</p>`;
});
