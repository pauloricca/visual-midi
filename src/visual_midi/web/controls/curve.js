import { postCurveValue } from "../api.js";
import { applyNodeSizing } from "../utils/layout.js";

const STORAGE_PREFIX = "visual-midi:curve:";
const POINT_RADIUS = 8;
const HIT_RADIUS = 14;
const MIN_POINT_GAP = 0.001;
const activeCurveStates = new Set();

export function clearCurveViews() {
  for (const state of activeCurveStates) {
    if (state.requestFrame !== null) {
      window.cancelAnimationFrame(state.requestFrame);
      state.requestFrame = null;
    }
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
    }
    state.playing = false;
  }
  activeCurveStates.clear();
}

export function renderCurve(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "curve-control";
  wrapper.dataset.key = node.key;
  wrapper.style.setProperty("--curve-accent", node.color || "#d26a2e");
  applyNodeSizing(wrapper, node);

  const canvas = document.createElement("canvas");
  canvas.className = "curve-canvas";

  const chrome = document.createElement("div");
  chrome.className = "curve-chrome";

  const actions = document.createElement("div");
  actions.className = "curve-actions";

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "curve-action-button curve-action-button--primary";

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "curve-action-button";
  clearButton.textContent = "Clear";
  actions.append(playButton, clearButton);

  chrome.append(actions);
  if (node.showLabel !== false) {
    const label = document.createElement("div");
    label.className = "curve-label";

    const meta = document.createElement("div");
    meta.className = "curve-meta";
    meta.textContent = buildCurveMeta(node);

    const title = document.createElement("div");
    title.className = "curve-title";
    title.textContent = node.name;

    label.append(meta, title);
    chrome.append(label);
  }

  wrapper.append(canvas, chrome);

  const state = {
    ...node,
    element: wrapper,
    canvas,
    context: canvas.getContext("2d"),
    points: loadPoints(node),
    dragIndex: -1,
    dragPointerId: null,
    movedDuringDrag: false,
    playhead: node.mode === "loop" ? 0 : null,
    playing: node.mode === "loop",
    startedAt: performance.now(),
    requestFrame: null,
    pendingRequest: false,
    queuedValue: null,
    resizeObserver: null,
    playButton,
  };

  const resizeObserver = new ResizeObserver(() => drawCurve(state));
  state.resizeObserver = resizeObserver;
  resizeObserver.observe(canvas);
  activeCurveStates.add(state);

  canvas.addEventListener("pointerdown", (event) => handlePointerDown(state, event));
  canvas.addEventListener("pointermove", (event) => handlePointerMove(state, event));
  canvas.addEventListener("pointerup", (event) => handlePointerUp(state, event));
  canvas.addEventListener("pointercancel", (event) => handlePointerCancel(state, event));
  canvas.addEventListener("dblclick", (event) => handleDoubleClick(state, event));

  clearButton.addEventListener("click", () => {
    state.points = initialPoints(state);
    persistPoints(state);
    drawCurve(state);
  });

  playButton.addEventListener("click", () => toggleCurvePlayback(state));

  drawCurve(state);
  updatePlayButton(state);
  if (state.playing) {
    state.element.classList.add("is-playing");
    state.requestFrame = window.requestAnimationFrame((now) => tickCurve(state, now));
  }

  return wrapper;
}

function loadPoints(node) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${STORAGE_PREFIX}${node.key}`) || "null");
    if (Array.isArray(parsed)) {
      const points = parsed
        .map((point) => ({
          x: clamp(Number(point.x), 0, 1),
          y: clamp(Number(point.y), 0, 1),
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length > 0) {
        points.sort((a, b) => a.x - b.x);
        points[0].x = 0;
        return collapseDuplicateTimes(points);
      }
    }
  } catch (_error) {
  }
  return initialPoints(node);
}

function initialPoints(node) {
  return [{ x: 0, y: initialRatio(node) }];
}

function initialRatio(node) {
  const defaultValue = Number.isFinite(Number(node.default)) ? Number(node.default) : Number(node.initial);
  if (node.max === node.min) {
    return 0;
  }
  return clamp((defaultValue - node.min) / (node.max - node.min), 0, 1);
}

function collapseDuplicateTimes(points) {
  const collapsed = [];
  for (const point of points) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && Math.abs(previous.x - point.x) < MIN_POINT_GAP) {
      previous.y = point.y;
      continue;
    }
    collapsed.push(point);
  }
  collapsed[0].x = 0;
  return collapsed;
}

function persistPoints(state) {
  window.localStorage.setItem(`${STORAGE_PREFIX}${state.key}`, JSON.stringify(state.points));
}

function handlePointerDown(state, event) {
  const pointer = eventToPoint(state, event);
  const index = findPointIndex(state, pointer);
  if (index < 0) {
    state.dragIndex = addPoint(state, eventToRatio(state, event));
  } else {
    state.dragIndex = index;
  }
  state.dragPointerId = event.pointerId;
  state.movedDuringDrag = false;
  state.canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function handlePointerMove(state, event) {
  if (state.dragPointerId !== event.pointerId || state.dragIndex < 0) {
    return;
  }
  const pointer = eventToRatio(state, event);
  const index = state.dragIndex;
  const previousX = index > 0 ? state.points[index - 1].x + MIN_POINT_GAP : 0;
  const nextX = index < state.points.length - 1 ? state.points[index + 1].x - MIN_POINT_GAP : 1;
  state.points[index] = {
    x: index === 0 ? 0 : clamp(pointer.x, previousX, nextX),
    y: clamp(pointer.y, 0, 1),
  };
  state.movedDuringDrag = true;
  persistPoints(state);
  drawCurve(state);
  event.preventDefault();
}

function handlePointerUp(state, event) {
  if (state.dragPointerId === event.pointerId) {
    const wasDragging = state.dragIndex >= 0;
    const moved = state.movedDuringDrag;
    state.canvas.releasePointerCapture(event.pointerId);
    state.dragIndex = -1;
    state.dragPointerId = null;
    state.movedDuringDrag = false;
    if (wasDragging || moved) {
      event.preventDefault();
      return;
    }
  }
}

function handlePointerCancel(state, event) {
  if (state.dragPointerId !== event.pointerId) {
    return;
  }
  state.dragIndex = -1;
  state.dragPointerId = null;
  state.movedDuringDrag = false;
}

function handleDoubleClick(state, event) {
  const index = findPointIndex(state, eventToPoint(state, event));
  if (index <= 0) {
    return;
  }
  state.points.splice(index, 1);
  persistPoints(state);
  drawCurve(state);
  event.preventDefault();
}

function addPoint(state, ratio) {
  const point = {
    x: clamp(ratio.x, MIN_POINT_GAP, 1),
    y: clamp(ratio.y, 0, 1),
  };
  state.points.push(point);
  state.points.sort((a, b) => a.x - b.x);
  const collapsed = collapseDuplicateTimes(state.points);
  let index = collapsed.indexOf(point);
  if (index < 0) {
    index = collapsed.findIndex(
      (candidate) =>
        Math.abs(candidate.x - point.x) < MIN_POINT_GAP && Math.abs(candidate.y - point.y) < MIN_POINT_GAP
    );
  }
  state.points = collapsed;
  persistPoints(state);
  drawCurve(state);
  return index;
}

function toggleCurvePlayback(state) {
  if (state.playing) {
    stopCurve(state);
    return;
  }
  startCurve(state);
}

function startCurve(state) {
  if (state.requestFrame !== null) {
    window.cancelAnimationFrame(state.requestFrame);
    state.requestFrame = null;
  }
  state.startedAt = performance.now();
  state.playhead = 0;
  state.playing = true;
  state.element.classList.add("is-playing");
  updatePlayButton(state);
  state.requestFrame = window.requestAnimationFrame((now) => tickCurve(state, now));
}

function stopCurve(state) {
  if (state.requestFrame !== null) {
    window.cancelAnimationFrame(state.requestFrame);
    state.requestFrame = null;
  }
  state.playing = false;
  state.playhead = null;
  state.element.classList.remove("is-playing");
  updatePlayButton(state);
  drawCurve(state);
}

function tickCurve(state, now) {
  const lengthMs = Math.max(0.001, Number(state.length) || 1) * 1000;
  const elapsed = now - state.startedAt;
  let phase = elapsed / lengthMs;

  if (state.mode === "loop") {
    phase = phase % 1;
    state.playhead = phase;
  } else if (phase >= 1) {
    phase = 1;
    state.playhead = 1;
  } else {
    state.playhead = phase;
  }

  queueCurveValue(state, valueAtPhase(state, phase));
  drawCurve(state);

  if (state.mode === "trigger" && phase >= 1) {
    state.playing = false;
    state.playhead = null;
    state.element.classList.remove("is-playing");
    state.requestFrame = null;
    updatePlayButton(state);
    drawCurve(state);
    return;
  }

  state.requestFrame = window.requestAnimationFrame((nextNow) => tickCurve(state, nextNow));
}

function valueAtPhase(state, phase) {
  const ratio = ratioAtPhase(state.points, phase);
  return state.min + (ratio * (state.max - state.min));
}

function ratioAtPhase(points, phase) {
  if (points.length === 0) {
    return 0;
  }
  let previous = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    if (phase <= next.x) {
      const span = next.x - previous.x;
      const local = span <= 0 ? 0 : (phase - previous.x) / span;
      return previous.y + ((next.y - previous.y) * local);
    }
    previous = next;
  }
  const span = 1 - previous.x;
  if (span <= 0) {
    return points[0].y;
  }
  const local = (phase - previous.x) / span;
  return previous.y + ((points[0].y - previous.y) * local);
}

function drawCurve(state) {
  const { canvas, context } = state;
  if (!context) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.save();
  context.globalAlpha = 0.18;
  context.fillStyle = state.color || "#d26a2e";
  context.fillRect(0, 0, width, height);
  context.restore();

  drawGrid(context, width, height);
  drawLine(state, width, height);
  drawPoints(state, width, height);
  if (state.playhead !== null) {
    drawPlayhead(context, state.playhead, width, height);
  }
}

function drawGrid(context, width, height) {
  context.strokeStyle = "rgba(0, 0, 0, 0.14)";
  context.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const x = (width * index) / 4;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let index = 1; index < 4; index += 1) {
    const y = (height * index) / 4;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function drawLine(state, width, height) {
  const points = state.points;
  contextPath(state.context, points, width, height);
  state.context.strokeStyle = "black";
  state.context.lineWidth = 3;
  state.context.lineJoin = "round";
  state.context.lineCap = "round";
  state.context.stroke();

  const last = points[points.length - 1];
  const first = points[0];
  state.context.beginPath();
  state.context.moveTo(last.x * width, (1 - last.y) * height);
  state.context.lineTo(width, (1 - first.y) * height);
  state.context.stroke();
}

function contextPath(context, points, width, height) {
  context.beginPath();
  points.forEach((point, index) => {
    const x = point.x * width;
    const y = (1 - point.y) * height;
    if (index === 0) {
      context.moveTo(x, y);
      return;
    }
    context.lineTo(x, y);
  });
}

function drawPoints(state, width, height) {
  for (const point of state.points) {
    const x = point.x * width;
    const y = (1 - point.y) * height;
    state.context.fillStyle = state.color || "#d26a2e";
    state.context.strokeStyle = "black";
    state.context.lineWidth = 2;
    state.context.beginPath();
    state.context.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
    state.context.fill();
    state.context.stroke();
  }
}

function drawPlayhead(context, phase, width, height) {
  const x = clamp(phase, 0, 1) * width;
  context.strokeStyle = "rgba(0, 0, 0, 0.72)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
}

function eventToPoint(state, event) {
  const rect = state.canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function eventToRatio(state, event) {
  const rect = state.canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    y: clamp(1 - ((event.clientY - rect.top) / Math.max(1, rect.height)), 0, 1),
  };
}

function findPointIndex(state, pointer) {
  const rect = state.canvas.getBoundingClientRect();
  return state.points.findIndex((point) => {
    const dx = pointer.x - (point.x * rect.width);
    const dy = pointer.y - ((1 - point.y) * rect.height);
    return Math.hypot(dx, dy) <= HIT_RADIUS;
  });
}

function buildCurveMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`, `${node.mode}  ${node.length}s`, `Range ${node.min}..${node.max}`];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push(`OSC Range ${node.osc.min}..${node.osc.max}`);
  }
  return parts.join("\n");
}

function updatePlayButton(state) {
  state.playButton.textContent = state.playing ? "Stop" : "Play";
}

function queueCurveValue(state, value) {
  state.queuedValue = value;
  if (state.pendingRequest) {
    return;
  }
  void flushCurveValue(state);
}

async function flushCurveValue(state) {
  if (state.queuedValue === null) {
    return;
  }

  state.pendingRequest = true;
  const value = state.queuedValue;
  state.queuedValue = null;

  try {
    await postCurveValue(state.key, value);
  } catch (_error) {
  } finally {
    state.pendingRequest = false;
    if (state.queuedValue !== null) {
      void flushCurveValue(state);
    }
  }
}

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}
