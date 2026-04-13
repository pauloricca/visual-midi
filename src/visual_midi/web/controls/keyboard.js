import { sendKeyboardGate } from "../api.js";
import { applyNodeSizing } from "../utils/layout.js";
import {
  buildKeyboardNotes,
  buildScaleKeyboardNotes,
  formatMidiNote,
  formatPitchClass,
  formatScaleName,
} from "../utils/music.js";

export function renderKeyboard(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "keyboard-control";
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--keyboard-accent", node.color || "#d26a2e");

  const chrome = document.createElement("div");
  chrome.className = "keyboard-chrome";

  const meta = document.createElement("div");
  meta.className = "keyboard-meta";
  meta.textContent = buildKeyboardMeta(node);

  const title = document.createElement("div");
  title.className = "keyboard-title";
  title.textContent = node.name;

  chrome.append(meta, title);

  const surface = document.createElement("div");
  surface.className = "keyboard-surface";

  const whiteLayer = document.createElement("div");
  whiteLayer.className = "keyboard-white-layer";

  const blackLayer = document.createElement("div");
  blackLayer.className = "keyboard-black-layer";

  const scaleMode = Boolean(node.scale && Number.isInteger(node.root));
  const notes = scaleMode
    ? buildScaleKeyboardNotes(node.start, node.size, node.root, node.scale)
    : buildKeyboardNotes(node.start, node.size);
  const activePointers = new Map();
  const activeNotes = new Map();

  const incrementNote = (note) => {
    activeNotes.set(note, (activeNotes.get(note) || 0) + 1);
  };

  const decrementNote = (note) => {
    const count = activeNotes.get(note) || 0;
    if (count <= 1) {
      activeNotes.delete(note);
      return;
    }
    activeNotes.set(note, count - 1);
  };

  const updateKeyVisual = (note, isActive) => {
    const key = surface.querySelector(`[data-note="${note}"]`);
    if (!key) {
      return;
    }
    key.classList.toggle("is-active", isActive);
  };

  const activatePointerNote = (pointerId, note) => {
    const existingNote = activePointers.get(pointerId);
    if (existingNote === note) {
      return;
    }
    if (existingNote !== undefined) {
      releasePointer(pointerId);
    }
    activePointers.set(pointerId, note);
    incrementNote(note);
    updateKeyVisual(note, true);
    sendKeyboardGate(node.key, note, true);
  };

  const releasePointer = (pointerId) => {
    const note = activePointers.get(pointerId);
    if (note === undefined) {
      return;
    }
    activePointers.delete(pointerId);
    decrementNote(note);
    updateKeyVisual(note, activeNotes.has(note));
    sendKeyboardGate(node.key, note, false);
  };

  if (scaleMode) {
    surface.classList.add("keyboard-surface--scale");
    whiteLayer.classList.add("keyboard-white-layer--scale");
    notes.forEach((item) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "keyboard-key keyboard-key--scale";
      if (item.isRoot) {
        key.classList.add("keyboard-key--root");
      }
      key.dataset.note = String(item.note);
      key.setAttribute("aria-label", `${formatMidiNote(item.note)} key`);
      key.textContent = formatMidiNote(item.note);
      whiteLayer.appendChild(key);
    });
    surface.append(whiteLayer);
  } else {
    notes
      .filter((item) => !item.isBlack)
      .forEach((item) => {
        const key = document.createElement("button");
        key.type = "button";
        key.className = "keyboard-key keyboard-key--white";
        key.dataset.note = String(item.note);
        key.dataset.black = "false";
        key.setAttribute("aria-label", `${formatMidiNote(item.note)} key`);
        whiteLayer.appendChild(key);
      });

    const whiteCount = Math.max(
      1,
      notes.reduce((count, item) => count + (item.isBlack ? 0 : 1), 0)
    );
    wrapper.style.setProperty("--white-key-count", String(whiteCount));

    notes
      .filter((item) => item.isBlack)
      .forEach((item) => {
        const key = document.createElement("button");
        key.type = "button";
        key.className = "keyboard-key keyboard-key--black";
        key.dataset.note = String(item.note);
        key.dataset.black = "true";
        key.setAttribute("aria-label", `${formatMidiNote(item.note)} key`);
        const leftPercent = ((item.whiteSlot + 1) / whiteCount) * 100;
        key.style.left = `${leftPercent}%`;
        key.style.width = `${(100 / whiteCount) * 0.64}%`;
        blackLayer.appendChild(key);
      });

    surface.append(whiteLayer, blackLayer);
  }
  wrapper.append(surface, chrome);

  const resolveNoteFromPointer = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const key = target?.closest?.(".keyboard-key");
    if (!key || !surface.contains(key)) {
      return null;
    }
    return Number(key.dataset.note);
  };

  surface.addEventListener("pointerdown", (event) => {
    const note = resolveNoteFromPointer(event);
    if (note === null) {
      return;
    }
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    activatePointerNote(event.pointerId, note);
  });

  surface.addEventListener("pointermove", (event) => {
    if (!surface.hasPointerCapture(event.pointerId)) {
      return;
    }
    const note = resolveNoteFromPointer(event);
    if (note === null) {
      releasePointer(event.pointerId);
      return;
    }
    activatePointerNote(event.pointerId, note);
  });

  const endPointer = (event) => {
    releasePointer(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
  };

  surface.addEventListener("pointerup", endPointer);
  surface.addEventListener("pointercancel", endPointer);

  surface.addEventListener("lostpointercapture", (event) => {
    releasePointer(event.pointerId);
  });

  return wrapper;
}

function buildKeyboardMeta(node) {
  const end = node.start + node.size - 1;
  if (node.scale && Number.isInteger(node.root)) {
    return `CH ${node.channel}  ${formatPitchClass(node.root)} ${formatScaleName(node.scale)}  FROM ${formatMidiNote(node.start)}`;
  }
  return `CH ${node.channel}  NOTES ${formatMidiNote(node.start)}-${formatMidiNote(end)}`;
}
