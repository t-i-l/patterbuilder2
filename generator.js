// ─────────────────────────────────────────────────────────────
// Pattern-Regeln
// randomInt, preSplitLong und generateRegions sind 1:1 aus dem
// alten script.js übernommen – logisch NICHT verändern.
// ─────────────────────────────────────────────────────────────

export const COLORS = {
  yellow: '#FFF100',
  blush:  '#F8F0DD',
  canvas: '#FCF9F4',
};

// Baustein-Typ → Farbe Fläche / Pille (null = keine Pille)
export const BLOCK_TYPES = {
  default:  { fill: COLORS.blush,  pill: COLORS.yellow },
  inverted: { fill: COLORS.yellow, pill: COLORS.blush  },
  white:    { fill: COLORS.canvas, pill: null          },
};

// Zufalls-Integer inklusiv
export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Splitte lange 1×N/N×1-Regionen in max. 3er-Streifen
export function preSplitLong(regions) {
  const out = [];
  regions.forEach(reg => {
    if (reg.w > 3 && reg.h === 1) {
      let rem = reg.w, cc = reg.c;
      while (rem > 3) {
        out.push({ r: reg.r, c: cc, h: 1, w: 3 });
        cc += 3; rem -= 3;
      }
      out.push({ r: reg.r, c: cc, h: 1, w: rem });
    } else if (reg.h > 3 && reg.w === 1) {
      let rem = reg.h, rr = reg.r;
      while (rem > 3) {
        out.push({ r: rr, c: reg.c, h: 3, w: 1 });
        rr += 3; rem -= 3;
      }
      out.push({ r: rr, c: reg.c, h: rem, w: 1 });
    } else {
      out.push(reg);
    }
  });
  return out;
}

// Erzeugt exakt count Regionen per Splits
export function generateRegions(rows, cols, count) {
  let regions = preSplitLong([{ r: 0, c: 0, h: rows, w: cols }]);
  const history = [];

  for (let i = 1; i < count; i++) {
    regions.sort((a, b) => b.w * b.h - a.w * a.h);
    const reg = regions.shift();

    if (reg.w === 1 && reg.h === 1) {
      regions.push(reg);
      continue;
    }

    let orientation = reg.w > reg.h
      ? (Math.random() < 0.7 ? 'vertical' : 'horizontal')
      : (Math.random() < 0.7 ? 'horizontal' : 'vertical');

    if (history.length >= 2 &&
        history.at(-1) === history.at(-2)) {
      orientation = history.at(-1) === 'vertical'
        ? 'horizontal'
        : 'vertical';
    }
    history.push(orientation);

    let didSplit = false;
    if (orientation === 'vertical' && reg.w > 1) {
      const minS = Math.max(1, Math.floor(reg.w * 0.4));
      const maxS = Math.min(reg.w - 1, Math.ceil(reg.w * 0.6));
      const split = randomInt(minS, maxS);
      regions.push(
        { r: reg.r, c: reg.c,         h: reg.h, w: split },
        { r: reg.r, c: reg.c + split, h: reg.h, w: reg.w - split }
      );
      didSplit = true;
    } else if (orientation === 'horizontal' && reg.h > 1) {
      const minS = Math.max(1, Math.floor(reg.h * 0.4));
      const maxS = Math.min(reg.h - 1, Math.ceil(reg.h * 0.6));
      const split = randomInt(minS, maxS);
      regions.push(
        { r: reg.r,         c: reg.c, h: split,         w: reg.w },
        { r: reg.r + split, c: reg.c, h: reg.h - split, w: reg.w }
      );
      didSplit = true;
    }

    if (!didSplit) regions.push(reg);
    regions = preSplitLong(regions);
  }
  return regions;
}

// ─────────────────────────────────────────────────────────────
// Grid – identische Rechnung wie im alten generatePattern(),
// nur dass n jetzt fest aus dem Dropdown kommt.
// ─────────────────────────────────────────────────────────────
export function computeGrid(W, H, n) {
  const shortSide = Math.min(W, H);
  const gridSize  = shortSide / n;

  const baseCols = Math.floor(W / gridSize);
  const baseRows = Math.floor(H / gridSize);
  const overX    = W - baseCols * gridSize;
  const overY    = H - baseRows * gridSize;
  const cols     = (overX >= gridSize/2) ? baseCols + 1 : baseCols;
  const rows     = (overY >= gridSize/2) ? baseRows + 1 : baseRows;
  const absorbX  = (overX <  gridSize/2) ? overX : 0;
  const absorbY  = (overY <  gridSize/2) ? overY : 0;

  // Pixelgrenzen jeder Spalte/Zeile (letzte Grenze = Canvasrand,
  // egal ob absorbiert oder angeschnitten)
  const xEdges = [];
  for (let i = 0; i < cols; i++) xEdges.push(i * gridSize);
  xEdges.push(W);
  const yEdges = [];
  for (let i = 0; i < rows; i++) yEdges.push(i * gridSize);
  yEdges.push(H);

  return { W, H, n, gridSize, cols, rows, absorbX, absorbY, xEdges, yEdges };
}

// Die EINZIGE Umrechnung Grid-Koordinaten → Pixel
// (Absorb + Beschnitt exakt wie bisher). Genutzt von Canvas,
// Vorschau, Drag und Export.
export function blockRect(b, grid) {
  const { gridSize, cols, rows, absorbX, absorbY, W, H } = grid;
  const x = b.c * gridSize;
  const y = b.r * gridSize;
  let   w = b.w * gridSize;
  let   h = b.h * gridSize;
  if (b.c + b.w === cols && absorbX) w += absorbX;
  if (b.r + b.h === rows && absorbY) h += absorbY;
  w = Math.min(w, W - x);
  h = Math.min(h, H - y);
  return { x, y, w, h };
}

export function pillRadius(w, h) {
  return Math.min(w, h) / 2;
}

// Regel 5: 1 Zelle breit → max. 3 hoch, und umgekehrt
export function isValidSize(w, h) {
  if (w === 1 && h > 3) return false;
  if (h === 1 && w > 3) return false;
  return w >= 1 && h >= 1;
}

export function overlaps(a, b) {
  return a.c < b.c + b.w && b.c < a.c + a.w &&
         a.r < b.r + b.h && b.r < a.r + a.h;
}

// Random-Pattern (Regeln 6–8)
export function randomBlocks(grid, makeId) {
  const { rows, cols, n } = grid;
  let moduleCount = n === 1 ? randomInt(4, 5) : randomInt(5, 6);
  moduleCount     = Math.min(moduleCount, rows * cols);

  return generateRegions(rows, cols, moduleCount).map(reg => ({
    id: makeId(),
    r: reg.r, c: reg.c, w: reg.w, h: reg.h,
    type: Math.random() > 0.5 ? 'inverted' : 'default',
  }));
}

// SVG-Export frisch aus dem State
export function buildSVG(W, H, grid, blocks) {
  const f = v => +v.toFixed(4);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${COLORS.canvas}"/>`,
  ];
  // Weiße Bausteine liegen über allen farbigen
  const ordered = [...blocks.filter(b => b.type !== 'white'), ...blocks.filter(b => b.type === 'white')];
  for (const b of ordered) {
    const { x, y, w, h } = blockRect(b, grid);
    const t = BLOCK_TYPES[b.type];
    parts.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${t.fill}"/>`);
    if (t.pill) {
      const rv = f(pillRadius(w, h));
      parts.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${rv}" ry="${rv}" fill="${t.pill}"/>`);
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}
