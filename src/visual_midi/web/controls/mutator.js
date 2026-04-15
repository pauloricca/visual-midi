import { postMutatorAction } from "../api.js";
import { refreshFromPayload } from "../app.js";
import { applyNodeSizing } from "../utils/layout.js";

export function renderMutator(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "mutator-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--mutator-accent", node.color || "#d26a2e");

  const state = {
    ...node,
    pending: false,
  };

  const slider = document.createElement("input");
  slider.className = "mutator-degree";
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.01";
  slider.value = String(Number(node.value) || 0);
  slider.setAttribute("aria-label", `${node.name} mutation amount`);

  const actions = document.createElement("div");
  actions.className = "mutator-actions";

  const mutateButton = document.createElement("button");
  mutateButton.type = "button";
  mutateButton.className = "mutator-button";
  mutateButton.textContent = "Mutate";
  mutateButton.addEventListener("click", () => {
    void applyMutatorAction(state, slider, "mutate", undoButton);
  });

  const undoButton = document.createElement("button");
  undoButton.type = "button";
  undoButton.className = "mutator-button";
  undoButton.textContent = "Undo";
  undoButton.disabled = !node.canUndo;
  undoButton.addEventListener("click", () => {
    void applyMutatorAction(state, slider, "undo", undoButton);
  });

  actions.append(mutateButton, undoButton);
  wrapper.append(slider, actions);
  return wrapper;
}

async function applyMutatorAction(state, slider, action, undoButton) {
  if (state.pending) {
    return;
  }
  state.pending = true;
  try {
    const value = Math.max(0, Math.min(1, Number(slider.value) || 0));
    const response = await postMutatorAction(state.key, value, action);
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    refreshFromPayload(payload);
    undoButton.disabled = action === "undo";
  } catch (_error) {
  } finally {
    state.pending = false;
  }
}
