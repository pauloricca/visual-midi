const titleNode = document.querySelector("#app-title");
const layoutRoot = document.querySelector("#layout-root");
const qrPanel = document.querySelector("#qr-panel");
const qrLink = document.querySelector("#qr-link");
const qrImage = document.querySelector("#qr-image");

let currentVersion = null;

const INERTIA_VELOCITY_THRESHOLD = 80;
const INERTIA_FRICTION_PER_FRAME = 0.9;
const INERTIA_MIN_VELOCITY = 8;

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
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--accent", node.color || "#d26a2e");

  const fill = document.createElement("div");
  fill.className = "control-fill";

  const chrome = document.createElement("div");
  chrome.className = "control-chrome";

  const top = document.createElement("div");
  top.className = "control-topline";

  const title = document.createElement("div");
  title.className = "control-title";

  const meta = document.createElement("div");
  meta.className = "control-meta";
  meta.textContent = `CH ${node.channel}  CC ${node.control}`;

  chrome.append(meta, title);
  wrapper.append(fill, chrome);

  const state = {
    ...node,
    element: wrapper,
    fill,
    title,
    pendingRequest: false,
    queuedValue: null,
    dragStartX: 0,
    dragStartY: 0,
    dragStartValue: node.value,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
    velocity: 0,
    inertiaFrame: null,
  };

  updateSliderVisuals(state, node.value);

  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    stopInertia(state);
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragStartValue = state.value;
    state.lastPointerX = event.clientX;
    state.lastPointerY = event.clientY;
    state.lastPointerTime = performance.now();
    state.velocity = 0;
    wrapper.setPointerCapture(event.pointerId);
  });

  wrapper.addEventListener("pointermove", (event) => {
    if (!wrapper.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    updateFromPointer(state, event, performance.now());
  });

  wrapper.addEventListener("pointerup", (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
    maybeStartInertia(state);
  });

  wrapper.addEventListener("pointercancel", (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
    stopInertia(state);
  });

  return wrapper;
}

function updateFromPointer(state, event, now) {
  const rect = state.element.getBoundingClientRect();
  const travel =
    state.orientation === "vertical"
      ? -((event.clientY - state.dragStartY) / (rect.height || 1))
      : (event.clientX - state.dragStartX) / (rect.width || 1);
  const rawValue = state.dragStartValue + travel * (state.max - state.min);
  const nextValue = Math.round(rawValue);
  const boundedValue = clamp(nextValue, state.min, state.max);
  if (boundedValue === state.value) {
    updateVelocity(state, event, now, rect);
    return;
  }

  updateSliderVisuals(state, boundedValue);
  queueSliderUpdate(state, boundedValue);
  updateVelocity(state, event, now, rect);
}

function updateSliderVisuals(state, value) {
  state.value = value;
  const percentage = ((value - state.min) / (state.max - state.min || 1)) * 100;
  state.title.textContent = state.name;

  if (state.orientation === "vertical") {
    state.fill.style.height = `${percentage}%`;
    state.fill.style.width = "100%";
  } else {
    state.fill.style.width = `${percentage}%`;
    state.fill.style.height = "100%";
  }
}

function queueSliderUpdate(state, value) {
  state.queuedValue = value;
  if (state.pendingRequest) {
    return;
  }
  void flushSliderUpdate(state);
}

function updateVelocity(state, event, now, rect) {
  const pointerDelta =
    state.orientation === "vertical"
      ? -(event.clientY - state.lastPointerY) / (rect.height || 1)
      : (event.clientX - state.lastPointerX) / (rect.width || 1);
  const timeDelta = Math.max(now - state.lastPointerTime, 1);
  const instantVelocity =
    (pointerDelta * (state.max - state.min) * 1000) / timeDelta;
  state.velocity = state.velocity * 0.35 + instantVelocity * 0.65;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  state.lastPointerTime = now;
}

function maybeStartInertia(state) {
  const scaledVelocity = state.velocity * (state.inertia ?? 1);
  if (Math.abs(scaledVelocity) < INERTIA_VELOCITY_THRESHOLD) {
    state.velocity = 0;
    return;
  }
  state.velocity = scaledVelocity;

  let previousTime = performance.now();
  const tick = (now) => {
    const elapsed = Math.max(now - previousTime, 1);
    previousTime = now;

    const nextValue = clamp(
      Math.round(state.value + (state.velocity * elapsed) / 1000),
      state.min,
      state.max
    );

    if (nextValue !== state.value) {
      updateSliderVisuals(state, nextValue);
      queueSliderUpdate(state, nextValue);
    }

    state.velocity *= Math.pow(INERTIA_FRICTION_PER_FRAME, elapsed / 16.67);
    const hitBoundary = nextValue === state.min || nextValue === state.max;
    if (Math.abs(state.velocity) < INERTIA_MIN_VELOCITY || hitBoundary) {
      state.velocity = 0;
      state.inertiaFrame = null;
      return;
    }

    state.inertiaFrame = window.requestAnimationFrame(tick);
  };

  state.inertiaFrame = window.requestAnimationFrame(tick);
}

function stopInertia(state) {
  if (state.inertiaFrame !== null) {
    window.cancelAnimationFrame(state.inertiaFrame);
    state.inertiaFrame = null;
  }
  state.velocity = 0;
}

async function flushSliderUpdate(state) {
  if (state.queuedValue === null) {
    return;
  }

  state.pendingRequest = true;
  const value = state.queuedValue;
  state.queuedValue = null;

  try {
    await fetch("/api/slider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: state.key, value }),
    });
  } catch (_error) {
  } finally {
    state.pendingRequest = false;
    if (state.queuedValue !== null && state.queuedValue !== value) {
      void flushSliderUpdate(state);
    }
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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
  layoutRoot.replaceChildren(renderLayoutWithConfig(payload.layout, payload));
  applyQrPanel(payload);
  scheduleVersionPolling(payload.reloadPollMs);
}

function renderLayoutWithConfig(node, payload) {
  if (node.type === "slider") {
    return renderSlider({ ...node, inertia: payload.inertia });
  }

  const group = document.createElement("section");
  group.className = `layout-group layout-group--${node.type}`;
  applyNodeSizing(group, node);
  for (const child of node.children) {
    group.appendChild(renderLayoutWithConfig(child, payload));
  }
  return group;
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
