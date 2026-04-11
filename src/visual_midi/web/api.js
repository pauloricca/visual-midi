const gateRequestChains = new Map();

export function shouldHideQrPanel() {
  return new URLSearchParams(window.location.search).has("noqr");
}

export function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  if (shouldHideQrPanel()) {
    url.searchParams.set("noqr", "1");
  }
  return url.toString();
}

export async function fetchConfig() {
  const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Config request failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchVersion() {
  const response = await fetch("/api/version", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Version request failed: ${response.status}`);
  }
  return response.json();
}

export async function postSliderValue(key, value) {
  return fetch("/api/slider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

export async function postSequencerSteps(key, steps) {
  return fetch("/api/sequencer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, steps }),
  });
}

export async function postTempoValue(value) {
  return fetch("/api/tempo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export async function postMemoryAction(key, slot, action) {
  return fetch(apiUrl("/api/memory"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, slot, action }),
  });
}

export async function postTransportState(playing) {
  return fetch("/api/transport", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playing }),
  });
}

export function sendKeyboardGate(channel, note, gate) {
  void queueGateRequest(`keyboard:${channel}:${note}`, "/api/keyboard", { channel, note, gate });
}

export function sendButtonGate(key, gate) {
  void queueGateRequest(`button:${key}`, "/api/button", { key, gate });
}

function queueGateRequest(chainKey, url, payload) {
  const previous = gateRequestChains.get(chainKey) || Promise.resolve();
  const request = previous
    .catch(() => {})
    .then(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )
    .catch(() => {})
    .finally(() => {
      if (gateRequestChains.get(chainKey) === request) {
        gateRequestChains.delete(chainKey);
      }
    });
  gateRequestChains.set(chainKey, request);
}
