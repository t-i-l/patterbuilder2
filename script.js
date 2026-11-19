import {
  BLOCK_TYPES, computeGrid, blockRect, pillRadius, isValidSize,
  overlaps, randomBlocks, buildSVG,
} from './generator.js';
import { Spring, animate, reducedMotion } from './spring.js';

// ─────────────────────────────────────────────────────────────
// Referenzen
// ─────────────────────────────────────────────────────────────
const $ = s => document.querySelector(s);
const svg          = $('#patternCanvas');
const blockLayer   = $('#blockLayer');
const paper        = $('#paper');
const paperGive    = $('#paperGive');
const wrapper      = $('.canvas-wrapper');
const widthInput   = $('#canvasWidth');
const heightInput  = $('#canvasHeight');
const gridSelect   = $('#gridCount');
const randomBtn    = $('#randomBtn');
const exportBtn    = $('#exportBtn');
const tiles        = [...document.querySelectorAll('.tile')];

const SVGNS = 'http://www.w3.org/2000/svg';
const EDGE_ZONE = 16;          // Bildschirm-px für Resize-Kanten (Maus)
const EDGE_ZONE_TOUCH = 26;    // … bei Touch
const EDGE_OUTSIDE = 8;        // Kante auch von außen greifbar (leere Fläche)
const MAGNET = 10;             // Bildschirm-px: Kante rastet beim Ziehen an Gridlinie ein
const DRAG_THRESHOLD = 3;      // px, bevor ein Klick zum Drag wird
const MAX_TILT = 6;            // Grad – subtil
const SELECTED_OPACITY = 0.7;  // ausgewählte Kachel

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let idCounter = 0;
const makeId = () => `b${++idCounter}`;

const state = { W: 1200, H: 800, n: 2, grid: null, blocks: [] };
state.grid = computeGrid(state.W, state.H, state.n);

// Reine View-Infos (landen nie im Export)
const view = {
  hidden:    new Set(),   // Bausteine, die gerade als Ghost schweben
  dimmed:    new Set(),   // würden verdrängt → 30 %
  overrides: new Map(),   // id → animiertes Pixel-Rect (Resize)
  preview:   null,        // Zielfläche in Grid-Koordinaten
  hoverId:   null,
  selected:  new Set(),   // ausgewählte Bausteine (Cmd/Shift = mehrere, Delete löscht)
};
const elements = new Map(); // id → { g, rect, pill }

let active = null;          // laufende Interaktion

// ─────────────────────────────────────────────────────────────
// Koordinaten
// ─────────────────────────────────────────────────────────────
function svgBox() { return svg.getBoundingClientRect(); }
function screenScale() { return svgBox().width / state.W || 1; }

function clientToSvg(cx, cy) {
  const r = svgBox();
  return { x: (cx - r.left) * state.W / r.width, y: (cy - r.top) * state.H / r.height };
}
function svgRectToClient(rc) {
  const r = svgBox();
  const sx = r.width / state.W, sy = r.height / state.H;
  return { x: r.left + rc.x * sx, y: r.top + rc.y * sy, w: rc.w * sx, h: rc.h * sy };
}
function insideCanvas(cx, cy) {
  const r = svgBox();
  return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
}
// Zelle, in der v liegt
function cellIndex(edges, v) {
  for (let i = 0; i < edges.length - 1; i++) if (v < edges[i + 1]) return i;
  return edges.length - 2;
}
// Grid-Linie, die v am nächsten liegt
function nearestEdge(edges, v) {
  let best = 0, bd = Infinity;
  edges.forEach((e, i) => { const d = Math.abs(e - v); if (d < bd) { bd = d; best = i; } });
  return best;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Welche Bausteine würde ein Baustein vom Typ `type` auf `area` verdrängen?
// Weiß verdrängt nichts – er legt sich nur über alles andere.
function overlappedBy(area, exceptId, type) {
  if (type === 'white') return [];
  return state.blocks.filter(b => b.id !== exceptId && overlaps(b, area));
}
function displace(area, exceptId, type) {
  const gone = new Set(overlappedBy(area, exceptId, type).map(b => b.id));
  state.blocks = state.blocks.filter(b => !gone.has(b.id));
}

// ─────────────────────────────────────────────────────────────
// Rendering (immer aus state)
// ─────────────────────────────────────────────────────────────
function setRectAttrs(node, r) {
  node.setAttribute('x', r.x);
  node.setAttribute('y', r.y);
  node.setAttribute('width', Math.max(0, r.w));
  node.setAttribute('height', Math.max(0, r.h));
}

function createBlockEl(b) {
  const t = BLOCK_TYPES[b.type];
  const g = document.createElementNS(SVGNS, 'g');
  g.dataset.id = b.id;
  const rect = document.createElementNS(SVGNS, 'rect');
  rect.setAttribute('fill', t.fill);
  g.appendChild(rect);
  let pill = null;
  if (t.pill) {
    pill = document.createElementNS(SVGNS, 'rect');
    pill.setAttribute('fill', t.pill);
    g.appendChild(pill);
  }
  blockLayer.appendChild(g);
  const el = { g, rect, pill, appearing: false };
  elements.set(b.id, el);
  return el;
}

function removeEl(id, fade = true) {
  const el = elements.get(id);
  if (!el) return;
  elements.delete(id);
  if (!fade) { el.g.remove(); return; }
  el.g.style.transition = 'opacity 0.12s ease';
  el.g.style.opacity = 0;
  setTimeout(() => el.g.remove(), 140);
}

function clearElements() {
  elements.forEach(el => el.g.remove());
  elements.clear();
  lastOrder = '';
}

function setOpacityInstant(el, v) {
  el.g.style.transition = 'none';
  el.g.style.opacity = v;
  void el.g.getBoundingClientRect();
  el.g.style.transition = '';
}

function render() {
  const seen = new Set();
  for (const b of state.blocks) {
    seen.add(b.id);
    const el = elements.get(b.id) || createBlockEl(b);
    const r = view.overrides.get(b.id) || blockRect(b, state.grid);
    setRectAttrs(el.rect, r);
    if (el.pill) {
      setRectAttrs(el.pill, r);
      const rv = pillRadius(Math.max(0, r.w), Math.max(0, r.h));
      el.pill.setAttribute('rx', rv);
      el.pill.setAttribute('ry', rv);
    }
  }
  for (const id of [...elements.keys()]) if (!seen.has(id)) removeEl(id, true);
  orderLayers();

  for (const b of state.blocks) {
    const el = elements.get(b.id);
    if (el.appearing) continue;
    if (view.hidden.has(b.id)) { if (el.g.style.opacity !== '0') setOpacityInstant(el, 0); continue; }
    const target = view.dimmed.has(b.id) ? 0.3 : view.selected.has(b.id) ? SELECTED_OPACITY : 1;
    if (String(target) === el.g.style.opacity) continue;
    // Verdrängen-Vorschau etwas ruhiger, Auswahl schnell
    const dimChange = target === 0.3 || el.g.style.opacity === '0.3';
    el.g.style.transition = dimChange ? '' : 'opacity 0.14s ease';
    el.g.style.opacity = target;
  }
  renderOverlay();
}

// Reihenfolge: farbige Bausteine, darüber Weiß, ganz oben der ausgewählte /
// gerade bearbeitete Baustein.
let lastOrder = '';
function stackOrder() {   // unten → oben
  const isTop = b => view.selected.has(b.id) || (active?.kind === 'resize' && active.block === b);
  const resizing = active?.kind === 'resize' ? active.block : null;
  return [
    ...state.blocks.filter(b => b.type !== 'white' && !isTop(b)),
    ...state.blocks.filter(b => b.type === 'white' && !isTop(b)),
    ...state.blocks.filter(b => isTop(b) && b !== resizing),
    ...(resizing ? [resizing] : []),
  ];
}
function orderLayers() {
  const order = stackOrder().map(b => b.id);
  const key = order.join(',');
  if (key === lastOrder) return;
  lastOrder = key;
  order.forEach(id => {
    const el = elements.get(id);
    if (!el) return;
    // Umhängen im DOM bricht laufende CSS-Transitions ab → aktuellen Wert
    // festhalten, damit die Opacity danach weich weiterläuft.
    const current = getComputedStyle(el.g).opacity;
    blockLayer.appendChild(el.g);
    if (!el.appearing && el.g.style.opacity !== '0') {
      const t = el.g.style.transition;
      el.g.style.transition = 'none';
      el.g.style.opacity = current;
      void el.g.getBoundingClientRect();
      el.g.style.transition = t;
    }
  });
}

// Keine Konturen auf dem Canvas – Zustände nur über Transparenz.
function renderOverlay() {}

// Random: gestaffeltes Einblenden wie bisher
function renderAppear() {
  clearElements();
  render();
  state.blocks.forEach((b, i) => {
    const el = elements.get(b.id);
    el.appearing = true;
    setOpacityInstant(el, 0);
    setTimeout(() => {
      el.g.style.transition = 'opacity 0.3s cubic-bezier(0.5, 0.1, 0.5, 0.9)';
      el.g.style.opacity = view.dimmed.has(b.id) ? 0.3 : 1;
      setTimeout(() => { el.appearing = false; el.g.style.transition = ''; }, 320);
    }, i * 40);
  });
}

// ─────────────────────────────────────────────────────────────
// Canvas-Größe (wie updateScale(), nur auf das Papier-Element)
// ─────────────────────────────────────────────────────────────
function updateScale() {
  const { W, H } = state;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const { width: availW, height: availH } = wrapper.getBoundingClientRect();
  const scale = Math.min(availW / W, availH / H, 0.9) * 0.94;
  paper.style.width  = `${Math.floor(W * scale)}px`;
  paper.style.height = `${Math.floor(H * scale)}px`;
}

// Canvas gibt beim Ablegen minimal nach
const give = new Spring(1, { stiffness: 900, precision: 0.00005 });
let giveRunning = false;
function giveCanvas() {
  if (reducedMotion.matches) return;
  give.velocity -= 0.2;
  if (giveRunning) return;
  giveRunning = true;
  animate(dt => {
    give.step(dt);
    paperGive.style.transform = give.done ? '' : `scale(${give.value})`;
    if (give.done) giveRunning = false;
    return !give.done;
  });
}

// ─────────────────────────────────────────────────────────────
// Schwebender Baustein (Ghost)
// ─────────────────────────────────────────────────────────────
class Ghost {
  constructor(type, { x, y, w, h, ox, oy }) {
    const t = BLOCK_TYPES[type];
    this.el = document.createElement('div');
    this.el.className = 'ghost';
    const face = document.createElement('div');
    face.className = 'ghost-face';
    face.style.background = t.fill;
    if (t.pill) {
      const pill = document.createElement('div');
      pill.className = 'ghost-pill';
      pill.style.background = t.pill;
      face.appendChild(pill);
    }
    this.el.appendChild(face);
    document.body.appendChild(this.el);

    this.ox = ox; this.oy = oy;                       // Greifpunkt (Anteil)
    // Alle Federn kritisch gedämpft → smooth, kein Bounce
    this.x = new Spring(x, { stiffness: 900, precision: 0.4 });
    this.y = new Spring(y, { stiffness: 900, precision: 0.4 });
    this.w = new Spring(w, { stiffness: 380, precision: 0.4 });
    this.h = new Spring(h, { stiffness: 380, precision: 0.4 });
    this.rot = new Spring(0, { stiffness: 90, zeta: 1, precision: 0.05 });   // weich, kein Nachwippen
    this.scale = new Spring(1, { stiffness: 900, precision: 0.002 });
    this.lift = new Spring(0, { stiffness: 600, precision: 0.005 });
    this.opacity = new Spring(1, { stiffness: 700, precision: 0.01 });

    this.following = true;
    this.px = x; this.py = y;
    this.vx = 0; this.lastT = performance.now();
    this.onSettle = null;
    this.dead = false;

    this.apply();
    animate(dt => this.tick(dt));
  }

  pointer(cx, cy) {
    const t = performance.now();
    const dt = (t - this.lastT) / 1000;
    if (dt > 0.001) {
      const inst = (cx - this.px) / dt;
      this.vx = this.vx * 0.55 + inst * 0.45;
      this.lastT = t;
    }
    this.px = cx; this.py = cy;
  }

  // Ziel: Bildschirm-Rect, in das der Ghost fliegt
  release(target, onSettle) {
    this.following = false;
    // Schnelles Einrasten ins Grid
    [this.x, this.y, this.w, this.h, this.scale].forEach(sp => sp.configure(1800, 1));
    this.x.to(target.x + this.ox * target.w);
    this.y.to(target.y + this.oy * target.h);
    this.w.to(target.w); this.h.to(target.h);
    this.rot.configure(1200, 1).to(0);    // beim Einrasten zügig gerade
    this.scale.to(1); this.lift.to(0);
    this.opacity.to(1);
    this.onSettle = onSettle;
  }

  discard(target) {
    this.following = false;
    if (target) {
      this.x.to(target.x + this.ox * target.w);
      this.y.to(target.y + this.oy * target.h);
      this.w.to(target.w); this.h.to(target.h);
      this.scale.to(0.85);
    } else {
      this.x.to(this.px); this.y.to(this.py);
      this.scale.configure(1400, 1).to(0.7);   // Wegwerfen: zügig, leicht kleiner
    }
    this.rot.to(0); this.lift.to(0);
    this.opacity.configure(1400, 1).to(0);
    this.onSettle = null;
  }

  tick(dt) {
    if (this.dead) return false;
    if (this.following) {
      this.x.set(this.px); this.y.set(this.py);
      this.vx *= Math.exp(-dt * 7);           // ohne Bewegung → zurück auf 0°
      const dir = this.oy <= 0.5 ? 1 : -1;      // Papier hängt am Greifpunkt
      const tilt = reducedMotion.matches ? 0 : clamp(this.vx * 0.004 * dir, -MAX_TILT, MAX_TILT);
      this.rot.to(tilt);
    }
    for (const s of [this.x, this.y, this.w, this.h, this.rot, this.scale, this.lift, this.opacity]) s.step(dt);
    this.apply();

    if (!this.following) {
      const settled = [this.x, this.y, this.w, this.h, this.rot, this.scale, this.opacity].every(s => s.done);
      if (settled || this.opacity.value <= 0.01 && this.opacity.target === 0) {
        this.destroy();
        this.onSettle?.();
        return false;
      }
    }
    return true;
  }

  apply() {
    const w = Math.max(1, this.w.value), h = Math.max(1, this.h.value);
    const tlx = this.x.value - this.ox * w;
    const tly = this.y.value - this.oy * h;
    const s = this.el.style;
    s.width = `${w}px`;
    s.height = `${h}px`;
    s.transformOrigin = `${this.ox * w}px ${this.oy * h}px`;
    s.transform = `translate3d(${tlx}px, ${tly}px, 0) rotate(${this.rot.value}deg) scale(${this.scale.value})`;
    s.opacity = clamp(this.opacity.value, 0, 1);
    // keine Schatten
  }

  destroy() {
    this.dead = true;
    this.el.remove();
  }
}

// ─────────────────────────────────────────────────────────────
// Undo / Redo (einfacher State-Stack)
// ─────────────────────────────────────────────────────────────
const undoStack = [], redoStack = [];
const snapshot = () => ({ W: state.W, H: state.H, n: state.n, blocks: state.blocks.map(b => ({ ...b })) });

function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const formatChanged = s.W !== state.W || s.H !== state.H || s.n !== state.n;
  state.W = s.W; state.H = s.H; state.n = s.n;
  state.grid = computeGrid(state.W, state.H, state.n);
  state.blocks = s.blocks.map(b => ({ ...b }));
  view.hidden.clear(); view.dimmed.clear(); view.overrides.clear(); view.preview = null;
  view.selected = new Set([...view.selected].filter(id => state.blocks.some(b => b.id === id)));
  syncInputs();
  clearElements();
  if (formatChanged) updateScale();
  render();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// ─────────────────────────────────────────────────────────────
// 4.1 Neuen Baustein aus der Toolbar ziehen
// ─────────────────────────────────────────────────────────────
function startNewDrag(tile, e) {
  const type = tile.dataset.type;
  const tr = tile.getBoundingClientRect();
  const ghost = new Ghost(type, {
    x: e.clientX, y: e.clientY, w: tr.width, h: tr.height,
    ox: clamp((e.clientX - tr.left) / tr.width, 0, 1),
    oy: clamp((e.clientY - tr.top) / tr.height, 0, 1),
  });
  ghost.lift.to(1);
  active = { kind: 'new', type, tile, ghost, pointerId: e.pointerId, target: null };
  document.body.classList.add('is-dragging');
  updateNewDrag(e.clientX, e.clientY);
}

function updateNewDrag(cx, cy) {
  const a = active;
  a.ghost.pointer(cx, cy);
  if (insideCanvas(cx, cy)) {
    const p = clientToSvg(cx, cy);
    const { xEdges, yEdges } = state.grid;
    const target = { c: cellIndex(xEdges, p.x), r: cellIndex(yEdges, p.y), w: 1, h: 1 };
    const cr = svgRectToClient(blockRect(target, state.grid));
    a.ghost.w.to(cr.w); a.ghost.h.to(cr.h);
    a.target = target;
    setPreview(target, null, a.type);
  } else {
    const s = state.grid.gridSize * screenScale() * 0.7;
    a.ghost.w.to(s); a.ghost.h.to(s);
    a.target = null;
    setPreview(null);
  }
}

function endNewDrag(cx, cy, cancelled) {
  const a = active;
  active = null;
  document.body.classList.remove('is-dragging');
  setPreview(null);

  if (!cancelled && a.target && insideCanvas(cx, cy)) {
    pushHistory();
    const nb = { id: makeId(), ...a.target, type: a.type };
    displace(nb, null, a.type);
    state.blocks.push(nb);
    view.hidden.add(nb.id);
    selectOnly(null, false);
    render();
    a.ghost.release(svgRectToClient(blockRect(nb, state.grid)), () => land(nb.id));
  } else {
    const tr = a.tile.getBoundingClientRect();
    a.ghost.discard({ x: tr.left, y: tr.top, w: tr.width, h: tr.height });
  }
}

function land(id) {
  view.hidden.delete(id);
  const el = elements.get(id);
  if (el) setOpacityInstant(el, 1);
  render();
  giveCanvas();
}

// Tastatur: Kachel aktivieren → 1×1 in die erste freie Zelle
function placeFirstFree(type) {
  const { rows, cols } = state.grid;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = { r, c, w: 1, h: 1 };
    if (!state.blocks.some(b => overlaps(b, cell))) {
      pushHistory();
      const nb = { id: makeId(), ...cell, type };
      state.blocks.push(nb);
      render();
      const el = elements.get(nb.id);
      setOpacityInstant(el, 0);
      requestAnimationFrame(() => { el.g.style.opacity = 1; giveCanvas(); });
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 4.2 Baustein verschieben
// ─────────────────────────────────────────────────────────────
function beginMove(a, cx, cy) {
  const b = a.block;
  const rect = blockRect(b, state.grid);
  const cr = svgRectToClient(rect);
  a.ghost = new Ghost(b.type, {
    x: a.startX, y: a.startY, w: cr.w, h: cr.h,
    ox: clamp((a.startX - cr.x) / cr.w, 0, 1),
    oy: clamp((a.startY - cr.y) / cr.h, 0, 1),
  });
  a.ghost.scale.to(1.05);
  a.ghost.lift.to(1);
  a.pending = false;
  view.hidden.add(b.id);
  view.hoverId = null;
  document.body.classList.add('is-dragging');
  render();
  updateMove(cx, cy);
}

function updateMove(cx, cy) {
  const a = active, b = a.block;
  a.ghost.pointer(cx, cy);
  if (insideCanvas(cx, cy)) {
    const p = clientToSvg(cx, cy);
    const { xEdges, yEdges, cols, rows } = state.grid;
    const c = clamp(nearestEdge(xEdges, p.x - a.grip.x), 0, cols - b.w);
    const r = clamp(nearestEdge(yEdges, p.y - a.grip.y), 0, rows - b.h);
    a.target = { r, c, w: b.w, h: b.h };
    a.ghost.opacity.to(1);
    a.ghost.scale.to(1.05);
    setPreview(a.target, b.id, b.type);
  } else {
    a.target = null;
    a.ghost.opacity.to(0.45);         // „wird gelöscht“
    a.ghost.scale.to(0.85);           // … und etwas kleiner
    setPreview(null);
  }
}

function endMove(cx, cy, cancelled) {
  const a = active, b = a.block;
  active = null;
  document.body.classList.remove('is-dragging');
  setPreview(null);

  if (a.pending) {                     // nur geklickt → auswählen
    a.additive ? toggleSelect(b.id) : selectOnly(b.id);
    return;
  }

  if (cancelled) {                     // abgebrochen → zurück an alten Platz
    a.ghost.release(svgRectToClient(blockRect(b, state.grid)), () => land(b.id));
    return;
  }

  if (a.target && insideCanvas(cx, cy)) {
    const moved = a.target.r !== b.r || a.target.c !== b.c;
    if (moved) {
      pushHistory();
      const t = a.target;
      displace(t, b.id, b.type);
      b.r = t.r; b.c = t.c;
    }
    selectOnly(null, false);
    render();
    a.ghost.release(svgRectToClient(blockRect(b, state.grid)), () => land(b.id));
  } else {
    // Wegwerfen
    pushHistory();
    state.blocks = state.blocks.filter(x => x.id !== b.id);
    view.hidden.delete(b.id);
    selectOnly(null, false);
    removeEl(b.id, false);
    render();
    a.ghost.discard(null);
  }
}

// ─────────────────────────────────────────────────────────────
// 4.3 Resize
// ─────────────────────────────────────────────────────────────
function startResize(e, b, edges) {
  const rect = blockRect(b, state.grid);
  const p = clientToSvg(e.clientX, e.clientY);
  const anim = {
    // Beim Ziehen: steif (folgt dem Cursor stufenlos, Magnet weich).
    // Beim Loslassen: weicher → gleitet smooth ins Grid.
    x0: new Spring(rect.x, { stiffness: 1400, precision: 0.05 }),
    y0: new Spring(rect.y, { stiffness: 1400, precision: 0.05 }),
    x1: new Spring(rect.x + rect.w, { stiffness: 1400, precision: 0.05 }),
    y1: new Spring(rect.y + rect.h, { stiffness: 1400, precision: 0.05 }),
  };
  active = {
    kind: 'resize', block: b, edges, pointerId: e.pointerId,
    orig: { r: b.r, c: b.c, w: b.w, h: b.h },
    cand: { r: b.r, c: b.c, w: b.w, h: b.h },
    // Abstand Cursor ↔ gegriffene Kante, damit sie nicht springt
    off: {
      x: edges.l ? rect.x - p.x : edges.r ? rect.x + rect.w - p.x : 0,
      y: edges.t ? rect.y - p.y : edges.b ? rect.y + rect.h - p.y : 0,
    },
    anim,
  };
  view.hoverId = null;
  selectOnly(null, false);
  document.body.classList.add(`is-resizing-${cursorFor(edges)}`);

  const a = active;
  view.overrides.set(b.id, rectFromAnim(anim));
  animate(dt => {
    Object.values(anim).forEach(s => s.step(dt));
    const live = elements.has(b.id) && state.blocks.includes(b);
    if (live) view.overrides.set(b.id, rectFromAnim(anim));
    const settled = Object.values(anim).every(s => s.done);
    if (!live || (settled && active !== a)) {
      view.overrides.delete(b.id);
      render();
      return false;
    }
    render();
    return true;
  });
}

function rectFromAnim(an) {
  return { x: an.x0.value, y: an.y0.value, w: an.x1.value - an.x0.value, h: an.y1.value - an.y0.value };
}

function updateResize(cx, cy) {
  const a = active, o = a.orig, E = a.edges;
  const { xEdges, yEdges, cols, rows } = state.grid;
  const p = clientToSvg(cx, cy);
  const right = o.c + o.w, bottom = o.r + o.h;

  // Wunschgröße in ganzen Zellen + erlaubter Bereich (Grid-Rand, min. 1)
  let cw = o.w, ch = o.h, wMin = o.w, wMax = o.w, hMin = o.h, hMax = o.h;
  if (E.r) { cw = nearestEdge(xEdges, p.x + a.off.x) - o.c; wMin = 1; wMax = cols - o.c; }
  if (E.l) { cw = right - nearestEdge(xEdges, p.x + a.off.x); wMin = 1; wMax = right; }
  if (E.b) { ch = nearestEdge(yEdges, p.y + a.off.y) - o.r; hMin = 1; hMax = rows - o.r; }
  if (E.t) { ch = bottom - nearestEdge(yEdges, p.y + a.off.y); hMin = 1; hMax = bottom; }

  // Nächste gültige Größe (1:3-Regel) – Kante stoppt einfach
  let best = null, bd = Infinity;
  for (let w = wMin; w <= wMax; w++) for (let h = hMin; h <= hMax; h++) {
    if (!isValidSize(w, h)) continue;
    const d = Math.abs(w - cw) + Math.abs(h - ch) +
              0.001 * (Math.abs(w - a.cand.w) + Math.abs(h - a.cand.h));
    if (d < bd) { bd = d; best = { w, h }; }
  }
  if (!best) return;

  const cand = {
    w: best.w, h: best.h,
    c: E.l ? right - best.w : o.c,
    r: E.t ? bottom - best.h : o.r,
  };
  a.cand = cand;

  // Stufenlose Vorschau: gezogene Kante folgt dem Cursor, begrenzt auf
  // den gültigen Bereich (Grid-Rand, min. 1 Zelle, 1:3-Regel). In der
  // Nähe einer Gridlinie rastet sie magnetisch ein.
  const magnet = MAGNET / screenScale();
  const snap = (edges, v) => {
    const g = edges[nearestEdge(edges, v)];
    return Math.abs(g - v) < magnet ? g : v;
  };
  const range = (lo, hi, ok) => {
    const vals = [];
    for (let i = lo; i <= hi; i++) if (ok(i)) vals.push(i);
    return [Math.min(...vals), Math.max(...vals)];
  };
  if (E.r || E.l) {
    const [wLo, wHi] = range(wMin, wMax, w => isValidSize(w, cand.h));
    let ex = p.x + a.off.x;
    if (E.r) { ex = clamp(ex, xEdges[o.c + wLo], xEdges[o.c + wHi]); a.anim.x1.to(snap(xEdges, ex)); }
    else     { ex = clamp(ex, xEdges[right - wHi], xEdges[right - wLo]); a.anim.x0.to(snap(xEdges, ex)); }
  }
  if (E.b || E.t) {
    const [hLo, hHi] = range(hMin, hMax, h => isValidSize(cand.w, h));
    let ey = p.y + a.off.y;
    if (E.b) { ey = clamp(ey, yEdges[o.r + hLo], yEdges[o.r + hHi]); a.anim.y1.to(snap(yEdges, ey)); }
    else     { ey = clamp(ey, yEdges[bottom - hHi], yEdges[bottom - hLo]); a.anim.y0.to(snap(yEdges, ey)); }
  }
  setPreview(cand, a.block.id, a.block.type);
}

function endResize() {
  const a = active, b = a.block, c = a.cand;
  active = null;
  document.body.className = document.body.className.replace(/\bis-resizing-\S+/g, '').trim();
  setPreview(null);
  const changed = c.r !== b.r || c.c !== b.c || c.w !== b.w || c.h !== b.h;
  if (changed) {
    pushHistory();
    displace(c, b.id, b.type);
    Object.assign(b, c);
  }
  // Größe springt (smooth) ins Grid
  const tr = blockRect(c, state.grid);
  Object.values(a.anim).forEach(sp => sp.configure(900, 1));
  a.anim.x0.to(tr.x); a.anim.y0.to(tr.y);
  a.anim.x1.to(tr.x + tr.w); a.anim.y1.to(tr.y + tr.h);
  render();
}

// ─────────────────────────────────────────────────────────────
// Vorschau: Eckmarkierungen + Verdrängte halbtransparent
// ─────────────────────────────────────────────────────────────
function setPreview(area, exceptId, type) {
  view.preview = area;
  view.dimmed.clear();
  if (area) overlappedBy(area, exceptId, type).forEach(b => view.dimmed.add(b.id));
  render();
}

// ─────────────────────────────────────────────────────────────
// Hit-Testing + Cursor auf dem Canvas
// ─────────────────────────────────────────────────────────────
function edgesAt(r, p, zoneScreen) {
  const s = screenScale();
  // Zone max. 30 % der Kachel, damit innen immer Platz zum Greifen bleibt
  const zx = Math.min(zoneScreen, r.w * s * 0.3) / s;
  const zy = Math.min(zoneScreen, r.h * s * 0.3) / s;
  return {
    l: p.x - r.x < zx,
    r: r.x + r.w - p.x <= zx,
    t: p.y - r.y < zy,
    b: r.y + r.h - p.y <= zy,
  };
}

function hitTest(cx, cy, pointerType = 'mouse') {
  const box = svgBox();
  const out = EDGE_OUTSIDE;
  if (cx < box.left - out || cx > box.right + out || cy < box.top - out || cy > box.bottom + out) return null;
  const p = clientToSvg(cx, cy);
  const zone = pointerType === 'touch' ? EDGE_ZONE_TOUCH : EDGE_ZONE;
  const visible = stackOrder().reverse().filter(b => !view.hidden.has(b.id));   // oben zuerst

  // 1) Punkt liegt in einer Kachel
  for (const b of visible) {
    const r = blockRect(b, state.grid);
    if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) {
      return { block: b, edges: edgesAt(r, p, zone), p };
    }
  }
  // 2) Knapp außerhalb einer Kachel (leere Fläche / Canvasrand) → Kante greifen
  const o = (pointerType === 'touch' ? EDGE_ZONE_TOUCH / 2 : EDGE_OUTSIDE) / screenScale();
  for (const b of visible) {
    const r = blockRect(b, state.grid);
    const inX = p.x >= r.x - o && p.x <= r.x + r.w + o;
    const inY = p.y >= r.y - o && p.y <= r.y + r.h + o;
    if (!inX || !inY) continue;
    const edges = {
      l: p.x < r.x, r: p.x > r.x + r.w,
      t: p.y < r.y, b: p.y > r.y + r.h,
    };
    // Ecken mitnehmen, wenn man nah an ihnen ist
    const e2 = edgesAt(r, { x: clamp(p.x, r.x, r.x + r.w), y: clamp(p.y, r.y, r.y + r.h) }, zone);
    if (edges.l || edges.r) { edges.t ||= e2.t; edges.b ||= e2.b; }
    if (edges.t || edges.b) { edges.l ||= e2.l; edges.r ||= e2.r; }
    if (cursorFor(edges)) return { block: b, edges, p, outside: true };
  }
  return null;
}

function cursorFor(E) {
  const hor = E.l || E.r, ver = E.t || E.b;
  if (hor && ver) return (E.l && E.t) || (E.r && E.b) ? 'nwse' : 'nesw';
  if (hor) return 'ew';
  if (ver) return 'ns';
  return null;
}

function selectOnly(id, doRender = true) {
  view.selected = new Set(id ? [id] : []);
  if (doRender) render();
}
function toggleSelect(id) {
  view.selected.has(id) ? view.selected.delete(id) : view.selected.add(id);
  render();
}

function deleteSelected() {
  const ids = view.selected;
  if (!state.blocks.some(b => ids.has(b.id))) return;
  pushHistory();
  state.blocks = state.blocks.filter(b => !ids.has(b.id));
  view.selected = new Set();
  render();
}

function updateHover(e) {
  const hit = hitTest(e.clientX, e.clientY, e.pointerType);
  const id = hit ? hit.block.id : null;
  const cur = hit ? cursorFor(hit.edges) : null;
  wrapper.style.cursor = !hit ? '' : cur ? `${cur}-resize` : 'grab';
  view.hoverId = id;
}

// ─────────────────────────────────────────────────────────────
// Pointer-Events
// ─────────────────────────────────────────────────────────────
wrapper.addEventListener('pointerdown', e => {
  if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const hit = hitTest(e.clientX, e.clientY, e.pointerType);
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  if (!hit) { if (!additive) selectOnly(null); return; }
  e.preventDefault();
  const dir = cursorFor(hit.edges);
  if (dir) {
    startResize(e, hit.block, hit.edges);
  } else {
    const r = blockRect(hit.block, state.grid);
    active = {
      kind: 'move', pending: true, block: hit.block, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      grip: { x: hit.p.x - r.x, y: hit.p.y - r.y },
      target: null, additive,
    };
  }
});

wrapper.addEventListener('pointermove', e => { if (!active) updateHover(e); });
wrapper.addEventListener('pointerleave', () => {
  if (!active) view.hoverId = null;
});

// Laufende Interaktionen hängen global am Fenster, damit kein
// pointerup verloren geht (Capture-Verlust, Loslassen über Toolbar …)
function onActiveMove(e) {
  if (!active || e.pointerId !== active.pointerId) return;
  // Maus ohne gedrückte Taste → pointerup wurde verpasst
  if (e.pointerType === 'mouse' && e.buttons === 0) { onActiveEnd(e, false); return; }
  if (active.kind === 'new') updateNewDrag(e.clientX, e.clientY);
  else if (active.kind === 'move') {
    if (active.pending) {
      if (Math.hypot(e.clientX - active.startX, e.clientY - active.startY) < DRAG_THRESHOLD) return;
      beginMove(active, e.clientX, e.clientY);
    } else updateMove(e.clientX, e.clientY);
  } else if (active.kind === 'resize') updateResize(e.clientX, e.clientY);
}

function onActiveEnd(e, cancelled) {
  if (!active || e.pointerId !== active.pointerId) return;
  if (active.kind === 'new') endNewDrag(e.clientX, e.clientY, cancelled);
  else if (active.kind === 'move') endMove(e.clientX, e.clientY, cancelled);
  else if (active.kind === 'resize') endResize();
  updateHover(e);
}

window.addEventListener('pointermove', onActiveMove);
window.addEventListener('pointerup', e => onActiveEnd(e, false));
window.addEventListener('pointercancel', e => onActiveEnd(e, true));

tiles.forEach(tile => {
  tile.addEventListener('pointerdown', e => {
    if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    startNewDrag(tile, e);
  });
  tile.addEventListener('click', e => {
    if (e.detail === 0) placeFirstFree(tile.dataset.type);   // Tastatur
  });
});

// ─────────────────────────────────────────────────────────────
// 4.4 Random
// ─────────────────────────────────────────────────────────────
function generatePattern(withHistory = true) {
  if (withHistory) pushHistory();
  view.hidden.clear(); view.dimmed.clear(); view.overrides.clear(); view.preview = null;
  view.selected = new Set();
  state.blocks = randomBlocks(state.grid, makeId);
  renderAppear();
}

let pressing = false;
const release = () => { paper.classList.remove('is-pressed'); };
randomBtn.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  pressing = true;
  paper.classList.add('is-pressed');
});
randomBtn.addEventListener('pointerup', () => {
  if (!pressing) return;
  pressing = false;
  release();
  generatePattern();
});
randomBtn.addEventListener('pointerleave', () => { pressing = false; release(); });
randomBtn.addEventListener('pointercancel', () => { pressing = false; release(); });
randomBtn.addEventListener('click', e => { if (e.detail === 0) generatePattern(); });

// ─────────────────────────────────────────────────────────────
// 4.5 Größe / Grid-Anzahl
// ─────────────────────────────────────────────────────────────
function syncInputs() {
  widthInput.value = state.W;
  heightInput.value = state.H;
  gridSelect.value = String(state.n);
}

function applyFormat(W, H, n) {
  if (W === state.W && H === state.H && n === state.n) return;
  if (active) return;
  pushHistory();
  state.W = W; state.H = H; state.n = n;
  state.grid = computeGrid(W, H, n);
  state.blocks = [];
  view.hidden.clear(); view.dimmed.clear(); view.overrides.clear(); view.preview = null;
  view.selected = new Set();
  clearElements();
  updateScale();
  render();
}

function commitSize() {
  const parse = (input, fallback) => {
    const v = parseInt(String(input.value).replace(/\D/g, ''), 10);
    return Number.isFinite(v) && v >= 100 ? v : fallback;
  };
  const W = parse(widthInput, state.W);
  const H = parse(heightInput, state.H);
  widthInput.value = W; heightInput.value = H;
  applyFormat(W, H, state.n);
}

[widthInput, heightInput].forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitSize(); input.select(); }
    else if (e.key === 'Escape') { syncInputs(); input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const fallback = input === widthInput ? state.W : state.H;
      const cur = parseInt(input.value, 10);
      const step = (e.shiftKey ? 100 : 10) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = Math.max(100, (Number.isFinite(cur) ? cur : fallback) + step);
    }
  });
  input.addEventListener('blur', commitSize);
  input.addEventListener('focus', () => input.select());
});

gridSelect.addEventListener('change', () => {
  applyFormat(state.W, state.H, parseInt(gridSelect.value, 10));
});

// ─────────────────────────────────────────────────────────────
// 4.6 Export – frisch aus dem State
// ─────────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const { W, H } = state;
  const xml  = buildSVG(W, H, state.grid, state.blocks);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `pattern_${W}x${H}.svg`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ─────────────────────────────────────────────────────────────
// Tastatur: Undo / Redo
// ─────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (active) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape') { selectOnly(null); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (k === 'y') { e.preventDefault(); redo(); }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => { updateScale(); renderOverlay(); });
syncInputs();
updateScale();
generatePattern(false);

// Für Tests in der Konsole
window.__pb = { state, computeGrid, blockRect, buildSVG, get active() { return active; } };
