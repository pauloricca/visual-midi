import { clamp } from "./math.js";

export const SCALE_PATTERNS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  natural_minor: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  whole_tone: [0, 2, 4, 6, 8, 10],
  diminished_half_whole: [0, 1, 3, 4, 6, 7, 9, 10],
  diminished_whole_half: [0, 2, 3, 5, 6, 8, 9, 11],
};

export function buildKeyboardNotes(start, size) {
  const notes = [];
  let whiteSlot = 0;

  for (let offset = 0; offset < size; offset += 1) {
    const note = start + offset;
    const isBlack = isBlackKey(note);
    if (isBlack) {
      notes.push({ note, isBlack: true, whiteSlot: Math.max(0, whiteSlot - 1) });
      continue;
    }
    notes.push({ note, isBlack: false, whiteSlot });
    whiteSlot += 1;
  }

  return notes;
}

export function buildScaleKeyboardNotes(start, size, root, scaleName) {
  const allowed = new Set((SCALE_PATTERNS[scaleName] || []).map((interval) => (root + interval) % 12));
  const notes = [];
  for (let note = start; note <= 127 && notes.length < size; note += 1) {
    if (!allowed.has(note % 12)) {
      continue;
    }
    notes.push({ note, isRoot: note % 12 === root % 12 });
  }
  return notes;
}

export function formatMidiNote(note) {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(note / 12) - 1;
  return `${noteNames[note % 12]}${octave}`;
}

export function formatScaleName(scaleName) {
  return scaleName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatPitchClass(note) {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return noteNames[((note % 12) + 12) % 12];
}

export function quantizeSequencerValue(state, value) {
  const bounded = Math.round(clamp(value, state.min, state.max));
  if (state.mode !== "notes" || !state.scale || !Number.isInteger(state.root)) {
    return bounded;
  }
  const allowed = new Set((SCALE_PATTERNS[state.scale] || []).map((interval) => (state.root + interval) % 12));
  let best = bounded;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let note = state.min; note <= state.max; note += 1) {
    if (!allowed.has(note % 12)) {
      continue;
    }
    const distance = Math.abs(note - bounded);
    if (distance < bestDistance || (distance === bestDistance && note < best)) {
      best = note;
      bestDistance = distance;
    }
  }
  return best;
}

function isBlackKey(note) {
  return [1, 3, 6, 8, 10].includes(note % 12);
}
