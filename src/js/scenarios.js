// Param scenarios: named presets of @input values that the user can swap
// between in one program. The strip above the @input panel renders one
// chip per scenario plus a `+ scenario` chip to save the current values.
//
// Scenarios live on state.ui (so they round-trip through export and URL
// share) and are persisted via storage.js's program record.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { saveCurrentProgram } from './storage.js';
import { epPrompt, epConfirm } from './dialogs.js';
import { attachLongPress, closeMenu, showMenu } from './menu.js';

const stripEl = document.getElementById('scenariosStrip');

function getScenarios()   { return state.ui.scenarios || (state.ui.scenarios = {}); }
function getActive()      { return state.ui.activeScenario || null; }
function setActive(name)  { state.ui.activeScenario = name || null; }

// Snapshot the current @input chip values keyed by param name.
function captureCurrentParams() {
  const out = {};
  for (const p of state.params) out[p.name] = p.valueSrc;
  return out;
}

// Whether the active scenario's stored values still match the current params.
// Returns true if any value diverges (dirty), false if everything matches.
function isActiveDirty() {
  const active = getActive();
  if (!active) return false;
  const sc = getScenarios()[active];
  if (!sc) return true;  // active scenario no longer exists
  for (const p of state.params) {
    if (!(p.name in sc)) continue;
    if (p.valueSrc !== sc[p.name]) return true;
  }
  return false;
}

export async function saveCurrentAsNewScenario() {
  if (state.params.length === 0) {
    await epConfirm({
      title: 'No params to capture',
      message: 'Add one or more @input-tagged bindings first.',
      okLabel: 'OK',
    });
    return;
  }
  const raw = await epPrompt({
    title: 'Save scenario',
    message: 'Capture the current parameter values under a name.',
    label: 'name',
    value: '',
    okLabel: 'Save',
  });
  if (raw == null) return;
  const name = String(raw).trim();
  if (!name) return;
  const scenarios = getScenarios();
  scenarios[name] = captureCurrentParams();
  setActive(name);
  saveCurrentProgram({force: true});
  renderScenariosStrip();
}

function overwriteActiveScenario() {
  const active = getActive();
  if (!active) return;
  const scenarios = getScenarios();
  scenarios[active] = captureCurrentParams();
  saveCurrentProgram({force: true});
  renderScenariosStrip();
}

export function applyScenario(name) {
  const sc = getScenarios()[name];
  if (!sc) return;
  for (const p of state.params) {
    if (!(p.name in sc)) continue;
    const line = state.body[p.bodyIdx];
    if (!line) continue;
    const eq = line.src.indexOf('=');
    if (eq < 0) continue;
    line.src = line.src.slice(0, eq + 1) + ' ' + sc[p.name];
  }
  setActive(name);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  saveCurrentProgram({force: true});
  renderScenariosStrip();
}

async function renameScenario(oldName) {
  const raw = await epPrompt({
    title: 'Rename scenario',
    label: 'name',
    value: oldName,
    okLabel: 'Rename',
  });
  if (raw == null) return;
  const newName = String(raw).trim();
  if (!newName || newName === oldName) return;
  const scenarios = getScenarios();
  if (scenarios[newName]) {
    await epConfirm({
      title: 'Name in use',
      message: `A scenario named "${newName}" already exists.`,
      okLabel: 'OK',
    });
    return;
  }
  scenarios[newName] = scenarios[oldName];
  delete scenarios[oldName];
  if (getActive() === oldName) setActive(newName);
  saveCurrentProgram({force: true});
  renderScenariosStrip();
}

async function deleteScenario(name) {
  const ok = await epConfirm({
    title: 'Delete scenario?',
    message: `"${name}" will be removed. (The current @input values stay as-is.)`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const scenarios = getScenarios();
  delete scenarios[name];
  if (getActive() === name) setActive(null);
  saveCurrentProgram({force: true});
  renderScenariosStrip();
}

function openScenarioMenu(name, x, y, opts = {}) {
  showMenu([
    { label: 'rename', action: () => renameScenario(name) },
    { separator: true },
    { label: 'delete', action: () => deleteScenario(name), danger: true },
  ], x, y, opts);
}

export function renderScenariosStrip() {
  if (!stripEl) return;
  stripEl.innerHTML = '';

  const scenarios = getScenarios();
  const names = Object.keys(scenarios);
  const active = getActive();
  const dirty = isActiveDirty();

  // Strip is opt-in: hidden until the program has at least one saved
  // scenario. First-scenario creation is reachable from the drawer's
  // per-program ⋯ menu ("save scenario…"); after that, the strip's own
  // `+ scenario` chip handles further saves.
  if (names.length === 0) {
    stripEl.style.display = 'none';
    return;
  }
  stripEl.style.display = '';

  for (const name of names) {
    const chip = document.createElement('button');
    chip.className = 'scenario-chip' + (name === active && !dirty ? ' active' : '');
    chip.textContent = name;
    chip.addEventListener('click', () => applyScenario(name));
    attachLongPress(chip, (px, py) => openScenarioMenu(name, px, py));
    stripEl.appendChild(chip);
  }

  if (state.params.length > 0) {
    // When the active scenario is dirty, surface an overwrite chip alongside
    // the always-present "+ new scenario" chip — both affordances stay
    // reachable so the user can either save changes to the active scenario
    // OR capture them as a brand-new scenario.
    if (active && dirty) {
      const save = document.createElement('button');
      save.className = 'scenario-chip save';
      save.textContent = `save ${active}`;
      save.title = `Overwrite "${active}" with the current values`;
      save.addEventListener('click', overwriteActiveScenario);
      stripEl.appendChild(save);
    }

    const add = document.createElement('button');
    add.className = 'scenario-chip add';
    add.textContent = '+ scenario';
    add.title = 'Save the current @input values as a new scenario';
    add.addEventListener('click', saveCurrentAsNewScenario);
    stripEl.appendChild(add);
  }
}

// Re-render the strip whenever params or storage state changes.
window.addEventListener('ep:storage-changed', renderScenariosStrip);
window.addEventListener('ep:params-changed',  renderScenariosStrip);
