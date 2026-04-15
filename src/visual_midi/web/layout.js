import { renderButton } from "./controls/button.js";
import { renderKeyboard } from "./controls/keyboard.js";
import { renderLfo } from "./controls/lfo.js";
import { renderMemory } from "./controls/memory.js";
import { renderMutator } from "./controls/mutator.js";
import { renderSequencer } from "./controls/sequencer.js";
import { renderTempo } from "./controls/tempo.js";
import { applyGroupTracks, applyNodeSizing } from "./utils/layout.js";

export function renderLayoutWithConfig(node, payload) {
  if (node.type === "slider") {
    return renderLfo({ ...node, inertia: payload.inertia });
  }
  if (node.type === "lfo") {
    return renderLfo(node);
  }
  if (node.type === "keyboard") {
    return renderKeyboard(node);
  }
  if (node.type === "button") {
    return renderButton(node);
  }
  if (node.type === "tempo") {
    return renderTempo(node);
  }
  if (node.type === "sequencer") {
    return renderSequencer(node);
  }
  if (node.type === "memory") {
    return renderMemory(node);
  }
  if (node.type === "mutator") {
    return renderMutator(node);
  }
  if (node.type === "tabs") {
    return renderTabs(node, payload);
  }

  const group = document.createElement("section");
  group.className = `layout-group layout-group--${node.type}`;
  applyNodeSizing(group, node);
  applyGroupTracks(group, node);
  for (const child of node.children) {
    group.appendChild(renderLayoutWithConfig(child, payload));
  }
  return group;
}

function renderTabs(node, payload) {
  const tabs = document.createElement("section");
  tabs.className = "layout-tabs";
  applyNodeSizing(tabs, node);

  const nav = document.createElement("div");
  nav.className = "layout-tabs-nav";
  nav.setAttribute("role", "tablist");

  const viewport = document.createElement("div");
  viewport.className = "layout-tabs-viewport";

  const track = document.createElement("div");
  track.className = "layout-tabs-track";
  const panelWidthPercent = 100 / node.tabs.length;
  track.style.width = `${node.tabs.length * 100}%`;
  viewport.appendChild(track);

  let activeIndex = 0;
  const buttons = [];
  const panels = [];

  const syncActiveTab = () => {
    track.style.transform = `translateX(-${activeIndex * panelWidthPercent}%)`;
    buttons.forEach((button, index) => {
      const isActive = index === activeIndex;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      panels[index].setAttribute("aria-hidden", String(!isActive));
    });
  };

  node.tabs.forEach((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layout-tab-button";
    button.textContent = tab.name;
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      activeIndex = index;
      syncActiveTab();
    });
    nav.appendChild(button);
    buttons.push(button);

    const panel = document.createElement("section");
    panel.className = "layout-tab-panel";
    panel.setAttribute("role", "tabpanel");
    panel.style.flexBasis = `${panelWidthPercent}%`;
    panel.appendChild(renderLayoutWithConfig(tab.content, payload));
    track.appendChild(panel);
    panels.push(panel);
  });

  tabs.append(nav, viewport);
  syncActiveTab();
  return tabs;
}
