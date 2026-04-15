import { postMutatorAction } from "../api.js";
import { refreshFromPayload } from "../app.js";
import { applyNodeSizing } from "../utils/layout.js";
import { createSlider } from "../ui/slider.js";

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

  const degree = createSlider({
    className: "mutator-degree",
    fillClassName: "mutator-degree-fill",
    value: Number(node.value) || 0,
    min: 0,
    max: 1,
    steps: null,
    orientation: "horizontal",
    color: node.color || "#d26a2e",
    wheelAxis: "horizontal",
    ariaLabel: `${node.name} mutation amount`,
  });

  const actions = document.createElement("div");
  actions.className = "mutator-actions";

  const mutateButton = document.createElement("button");
  mutateButton.type = "button";
  mutateButton.className = "mutator-button";
  mutateButton.textContent = "Mutate";
  mutateButton.addEventListener("click", () => {
    void applyMutatorAction(state, degree, "mutate", undoButton);
  });

  const undoButton = document.createElement("button");
  undoButton.type = "button";
  undoButton.className = "mutator-button";
  undoButton.textContent = "Undo";
  undoButton.disabled = !node.canUndo;
  undoButton.addEventListener("click", () => {
    void applyMutatorAction(state, degree, "undo", undoButton);
  });

  actions.append(mutateButton, undoButton);
  wrapper.append(degree.element, actions);
  return wrapper;
}

async function applyMutatorAction(state, degree, action, undoButton) {
  if (state.pending) {
    return;
  }
  state.pending = true;
  try {
    const value = degree.getValue();
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
