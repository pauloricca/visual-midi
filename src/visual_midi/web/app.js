import { fetchConfig, fetchVersion, shouldHideQrPanel } from "./api.js";
import { appHeader, layoutRoot, qrImage, qrLink, qrPanel, titleNode } from "./dom.js";
import { renderLayoutWithConfig } from "./layout.js";
import { clearSequencerViews, syncTransportState } from "./controls/sequencer.js";
import { clearLfoViews, syncLfoTransportState } from "./controls/lfo.js";
import { clearTempoViews, installTempoShortcuts } from "./controls/tempo.js";
import { clearCurveViews, syncCurveTransportState } from "./controls/curve.js";
import { resetDynamicControlValues, seedDynamicControlValuesFromLayout } from "./utils/dynamic.js";

let currentVersion = null;
let pollTimer = null;
let currentPayload = null;

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

function applyPayload(payload, options = {}) {
  const renderPayload = withVisualTransitions(payload, currentPayload, options.transitionSeconds);
  currentVersion = payload.version;
  document.title = payload.title || "visual-midi";
  if (payload.title) {
    appHeader.hidden = false;
    titleNode.textContent = payload.title;
  } else {
    appHeader.hidden = true;
    titleNode.textContent = "";
  }
  clearSequencerViews();
  clearLfoViews();
  clearTempoViews();
  clearCurveViews();
  resetDynamicControlValues();
  seedDynamicControlValuesFromLayout(renderPayload.layout);
  layoutRoot.replaceChildren(renderLayoutWithConfig(renderPayload.layout, renderPayload));
  syncTransportState(payload.transport, { resetAnchors: true });
  syncLfoTransportState(payload.transport);
  syncCurveTransportState(payload.transport);
  applyQrPanel(payload);
  scheduleVersionPolling(payload.reloadPollMs);
  currentPayload = payload;
}

export async function loadApp() {
  installInfoToggleShortcut();
  installTempoShortcuts();
  const payload = await fetchConfig();
  applyPayload(payload);
}

export function refreshFromPayload(payload, options = {}) {
  applyPayload(payload, options);
}

function withVisualTransitions(payload, previousPayload, transitionSeconds) {
  const duration = Number(transitionSeconds) || 0;
  if (duration <= 0 || !previousPayload) {
    return payload;
  }

  const previousValues = collectContinuousValues(previousPayload.layout);
  if (previousValues.size === 0) {
    return payload;
  }

  const nextPayload = clonePayload(payload);
  annotateContinuousTransitions(nextPayload.layout, previousValues, duration);
  return nextPayload;
}

function clonePayload(payload) {
  if (typeof structuredClone === "function") {
    return structuredClone(payload);
  }
  return JSON.parse(JSON.stringify(payload));
}

function collectContinuousValues(node, values = new Map()) {
  if (node.type === "slider" && node.key) {
    values.set(node.key, Number(node.value));
    return values;
  }
  if (node.type === "tabs") {
    node.tabs.forEach((tab) => collectContinuousValues(tab.content, values));
    return values;
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => collectContinuousValues(child, values));
  }
  return values;
}

function annotateContinuousTransitions(node, previousValues, duration) {
  if (node.type === "slider" && node.key) {
    const previousValue = previousValues.get(node.key);
    const nextValue = Number(node.value);
    if (Number.isFinite(previousValue) && Number.isFinite(nextValue) && previousValue !== nextValue) {
      node.transitionFrom = previousValue;
      node.transitionDuration = duration;
    }
    return;
  }
  if (node.type === "tabs") {
    node.tabs.forEach((tab) => annotateContinuousTransitions(tab.content, previousValues, duration));
    return;
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => annotateContinuousTransitions(child, previousValues, duration));
  }
}

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

function installInfoToggleShortcut() {
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || event.key.toLowerCase() !== "h" || isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      document.documentElement.classList.toggle("show-control-meta");
    },
    { capture: true }
  );
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  const editable = target.closest("input, textarea, select, [contenteditable]");
  if (!editable) {
    return false;
  }
  return editable.getAttribute("contenteditable") !== "false";
}

loadApp().catch((error) => {
  layoutRoot.innerHTML = `<p class="error-state">${error.message}</p>`;
});
