// Procedural boards in the style of the classic wooden labyrinth: an open
// board with a winding guide line, numbered holes crowding the route, and
// short wooden blocks acting as rails and corner stops.
//
// The route is the deepest branch of a random depth-first maze on a coarse
// grid of nodes. Nodes sit on the odd cells of a fine grid, so passes of the
// line are always separated by a cell that can hold a hole or a block.
// Every level number always produces the same board.
//
// All positions returned are in fine-cell units (cell centres on integers).

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const EMPTY = 0, PATH = 1, HOLE = 2, WALL = 3;

export const WALL_LEN = 0.92;   // block length, in cells

/** Fine-grid nodes of the deepest branch of a random depth-first maze. */
function carveRoute(mc, mr, rng) {
  const nid = (i, j) => j * mc + i;
  const parent = new Int32Array(mc * mr).fill(-1);
  const depth = new Int32Array(mc * mr).fill(-1);
  const si = Math.max(0, Math.min(mc - 1, Math.round((mc - 1) / 2 + (rng() - 0.5) * 2)));
  const startNode = nid(si, 0);
  depth[startNode] = 0;
  const stack = [startNode];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const i = cur % mc, j = (cur / mc) | 0;
    const next = shuffle(DIRS.slice(), rng)
      .map(([dx, dy]) => [i + dx, j + dy])
      .find(([a, b]) => a >= 0 && b >= 0 && a < mc && b < mr && depth[nid(a, b)] < 0);
    if (!next) { stack.pop(); continue; }
    const n = nid(next[0], next[1]);
    depth[n] = depth[cur] + 1;
    parent[n] = cur;
    stack.push(n);
  }
  // Finish as deep as possible, preferring the rim and well away from the start.
  let endNode = startNode, best = -1;
  for (let n = 0; n < mc * mr; n++) {
    const i = n % mc, j = (n / mc) | 0;
    const rim = i === 0 || j === 0 || i === mc - 1 || j === mr - 1;
    const score = depth[n] + (rim ? 3 : 0) + 1.5 * Math.hypot(i - si, j);
    if (score > best) { best = score; endNode = n; }
  }
  const nodes = [];
  for (let n = endNode; n >= 0; n = parent[n]) nodes.unshift([(n % mc) * 2 + 1, ((n / mc) | 0) * 2 + 1]);
  return nodes;
}

const RES = 8;    // raster samples per cell when tracing where the ball fits
const SKIP = 4;   // route cells an excursion may jump before it counts as a shortcut
const LANE = 0.75; // how far from the line (in cells) still counts as on the route

/**
 * Trace where the ball's centre can go (clear of blocks, the rim and hole
 * mouths), find the quickest way from START to FINISH, and wherever it
 * leaves the line to skip ahead, block the cell it slipped out through.
 * Repeat until the quickest way is the printed route. Adds to `holes` and
 * `walls` in place; returns how many cells it blocked and whether the board
 * ended up sealed.
 */
export function sealShortcuts({ cols, rows, kind, path, holes, walls, start, goal, geom }) {
  const { ballR, fallR, wallT } = geom;
  const gw = cols * RES, gh = rows * RES;
  const coord = (i) => (i + 0.5) / RES - 0.5;   // cell centres sit on integers
  const at = (x, y) => y * cols + x;
  const open = new Uint8Array(gw * gh);
  // Clear raster points within the box [x0,x1]x[y0,y1] grown by r (rounded corners).
  const carve = (x0, x1, y0, y1, r) => {
    const i0 = Math.max(0, Math.floor((x0 - r + 0.5) * RES)), i1 = Math.min(gw - 1, Math.ceil((x1 + r + 0.5) * RES));
    const j0 = Math.max(0, Math.floor((y0 - r + 0.5) * RES)), j1 = Math.min(gh - 1, Math.ceil((y1 + r + 0.5) * RES));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = coord(i), y = coord(j);
        const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
        if (dx * dx + dy * dy < r * r) open[j * gw + i] = 0;
      }
    }
  };
  const addHole = (h) => carve(h.x, h.x, h.y, h.y, fallR);
  const addWall = (w) => {
    const hl = WALL_LEN / 2, ht = wallT / 2;
    if (w.horizontal) carve(w.x - hl, w.x + hl, w.y - ht, w.y + ht, ballR);
    else carve(w.x - ht, w.x + ht, w.y - hl, w.y + hl, ballR);
  };
  const rasterize = () => {
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const x = coord(i), y = coord(j);
        open[j * gw + i] = x > -0.5 + ballR && y > -0.5 + ballR && x < cols - 0.5 - ballR && y < rows - 0.5 - ballR ? 1 : 0;
      }
    }
    holes.forEach(addHole);
    walls.forEach(addWall);
  };
  rasterize();

  // Where along the line (in route cells) each sample is nearest, and how far off it.
  const along = new Float32Array(gw * gh), off = new Float32Array(gw * gh);
  for (let p = 0; p < gw * gh; p++) {
    const x = coord(p % gw), y = coord((p / gw) | 0);
    let bestD = Infinity, bestT = 0;
    for (let k = 1; k < path.length; k++) {
      const [ax, ay] = path[k - 1], [bx, by] = path[k];
      const t = Math.max(0, Math.min(1, (x - ax) * (bx - ax) + (y - ay) * (by - ay)));
      const d = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
      if (d < bestD) { bestD = d; bestT = k - 1 + t; }
    }
    along[p] = bestT;
    off[p] = bestD;
  }

  const toRaster = ([x, y]) => Math.round((y + 0.5) * RES - 0.5) * gw + Math.round((x + 0.5) * RES - 0.5);
  const cellOf = (p) => at(Math.floor((p % gw) / RES), Math.floor(((p / gw) | 0) / RES));
  const src = toRaster(start), goalCell = at(goal[0], goal[1]);
  const prev = new Int32Array(gw * gh);

  // Fence the gap the ball slipped out through with a block in the cell at
  // raster point `exit`, laid parallel to the line it was leaving, so
  // neighbouring blocks line up into a wall between the passes. (Holes can't
  // seal a gap: the ball rolls between two neighbouring holes.) If that cell
  // is taken, use the free neighbouring cell nearest to the exit, swapping
  // out a hole if that's what is there; if a block in the way faces the
  // wrong way, cross it with a second one.
  const hasWall = (x, y, horizontal) => walls.some((w) => w.x === x && w.y === y && w.horizontal === horizontal);
  const block = (exit) => {
    const ei = exit % gw, ej = (exit / gw) | 0;
    const cx = Math.floor(ei / RES), cy = Math.floor(ej / RES);
    const k = Math.min(path.length - 2, Math.floor(along[exit]));
    const horizontal = path[k][1] === path[k + 1][1];
    let c = -1, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const kd = kind[at(x, y)];
        const usable = kd === EMPTY || kd === HOLE || (kd === WALL && !hasWall(x, y, horizontal));
        if (!usable) continue;
        // Prefer free cells; holes and crossings only when clearly the one in the way.
        const d = Math.hypot(x - coord(ei), y - coord(ej)) + (kd === EMPTY ? 0 : 0.25);
        if (d < bestD) { bestD = d; c = at(x, y); }
      }
    }
    if (c < 0) return false;
    const x = c % cols, y = (c / cols) | 0;
    const w = { x, y, horizontal };
    walls.push(w);
    if (kind[c] === HOLE) {
      holes.splice(holes.findIndex((h) => h.x === x && h.y === y), 1);
      kind[c] = WALL;
      rasterize();
    } else {
      kind[c] = WALL;
      addWall(w);
    }
    return true;
  };

  let blocked = 0, clean = false;
  for (let iter = 0; iter < 300; iter++) {
    // Breadth-first over the raster (8-connected) from the start.
    prev.fill(-1);
    prev[src] = src;
    const queue = [src];
    let found = -1;
    for (let qi = 0; qi < queue.length && found < 0; qi++) {
      const p = queue[qi];
      const pi = p % gw, pj = (p / gw) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = pi + di, j = pj + dj;
          if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
          const n = j * gw + i;
          if (!open[n] || prev[n] >= 0) continue;
          // No squeezing diagonally between two blocked samples.
          if (di && dj && !open[pj * gw + i] && !open[j * gw + pi]) continue;
          prev[n] = p;
          if (cellOf(n) === goalCell) { found = n; break; }
          queue.push(n);
        }
        if (found >= 0) break;
      }
    }
    if (found < 0) break;  // FINISH unreachable: shouldn't happen, the route is always clear

    const route = [];
    for (let p = found; p !== src; p = prev[p]) route.unshift(p);
    route.unshift(src);
    // Look for an excursion off the line that rejoins it far ahead.
    let lastT = 0, excursion = [], shortcut = false, sealed = false;
    for (const p of route) {
      if (off[p] <= LANE) {
        if (excursion.length && along[p] - lastT > SKIP) {
          shortcut = true;
          // Fence where it slipped out, or failing that anywhere along the way.
          sealed = excursion.some(block);
          break;
        }
        excursion = [];
        lastT = along[p];
      } else {
        excursion.push(p);
      }
    }
    if (!shortcut) { clean = true; break; }
    if (!sealed) break;   // nowhere left to put a block
    blocked++;
  }
  return { blocked, clean };
}

/**
 * `geom` gives the ball's radius, the radius within which a hole swallows it,
 * and the block thickness, all in cells; they decide where the ball fits
 * when sealing shortcuts.
 */
export function generateLevel(level, geom = { ballR: 0.23, fallR: 0.26, wallT: 0.185 }) {
  // Reroll the rare board that can't be sealed against shortcuts.
  let board;
  for (let variant = 0; variant < 6; variant++) {
    board = buildBoard(level, level * 7919 + 101 + variant * 104729, geom);
    if (board.seal.clean) break;
  }
  return board;
}

function buildBoard(level, seed, geom) {
  const rng = mulberry32(seed);
  const mc = level <= 3 ? 5 : 6;
  const mr = level <= 3 ? 5 : 6;
  const cols = mc * 2 + 1, rows = mr * 2 + 1;

  // --- Route: deepest branch of a recursive-backtracker maze on the nodes ---
  // A few attempts, keeping the longest, so the line covers most of the board.
  let nodes = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = carveRoute(mc, mr, rng);
    if (candidate.length > nodes.length) nodes = candidate;
  }

  const kind = new Uint8Array(cols * rows);
  const pathIndex = new Int32Array(cols * rows).fill(-1);
  const at = (x, y) => y * cols + x;
  const path = [];
  nodes.forEach(([x, y], k) => {
    if (k > 0) {
      const [px, py] = nodes[k - 1];
      path.push([(x + px) / 2, (y + py) / 2]);
    }
    path.push([x, y]);
  });
  path.forEach(([x, y], k) => { kind[at(x, y)] = PATH; pathIndex[at(x, y)] = k; });

  const holes = [];
  const walls = [];
  const [sx, sy] = nodes[0];
  const [gx, gy] = nodes[nodes.length - 1];
  const nearStart = (x, y) => Math.abs(x - sx) <= 1 && Math.abs(y - sy) <= 1;

  const holeP = Math.min(0.3 + level * 0.05, 0.6);
  const sideWallP = 0.35;
  const turnWallP = Math.max(0.85 - level * 0.06, 0.45);

  // --- Cells beside each route node: rails, corner stops or holes ---
  nodes.forEach(([x, y], k) => {
    const used = [];
    if (k > 0) used.push([Math.sign(nodes[k - 1][0] - x), Math.sign(nodes[k - 1][1] - y)]);
    if (k < nodes.length - 1) used.push([Math.sign(nodes[k + 1][0] - x), Math.sign(nodes[k + 1][1] - y)]);
    const turn = used.length === 2 && used[0][0] !== -used[1][0];
    for (const [dx, dy] of DIRS) {
      if (used.some(([ux, uy]) => ux === dx && uy === dy)) continue;
      const ex = x + dx, ey = y + dy;
      if (kind[at(ex, ey)] !== EMPTY) continue;
      const r = rng();
      let type;
      if (k <= 1 || k === nodes.length - 1) type = WALL;
      else if (turn) type = r < turnWallP ? WALL : HOLE;   // outside of a turn
      else type = r < holeP ? HOLE : r < holeP + sideWallP ? WALL : EMPTY;
      kind[at(ex, ey)] = type;
      // Blocks run perpendicular to the way out of the node: along the line
      // beside straights, across it at turns and between passes.
      if (type === WALL) walls.push({ x: ex, y: ey, horizontal: dx === 0 });
      if (type === HOLE) holes.push({ x: ex, y: ey });
    }
  });

  // --- Fill the rest of the board with holes, densest near the line ---
  const nearP = Math.min(0.45 + level * 0.05, 0.8);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (kind[at(x, y)] !== EMPTY || nearStart(x, y) || (x === gx && y === gy)) continue;
      let near = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ax = x + dx, ay = y + dy;
          if (ax >= 0 && ay >= 0 && ax < cols && ay < rows && kind[at(ax, ay)] === PATH) near = true;
        }
      }
      if (rng() < (near ? nearP : 0.6)) {
        kind[at(x, y)] = HOLE;
        holes.push({ x, y });
      }
    }
  }

  const seal = sealShortcuts({ cols, rows, kind, path, holes, walls, start: nodes[0], goal: nodes[nodes.length - 1], geom });

  // Later levels nudge holes toward the line to narrow the safe track.
  const nudge = Math.min(0.03 * level, 0.15);
  for (const h of holes) {
    for (const [dx, dy] of DIRS) {
      const ax = h.x + dx, ay = h.y + dy;
      if (ax < 0 || ay < 0 || ax >= cols || ay >= rows || kind[at(ax, ay)] !== PATH) continue;
      h.ox = dx * nudge;
      h.oy = dy * nudge;
      break;
    }
    h.ox ??= 0;
    h.oy ??= 0;
    // Route order of the earliest neighbouring line cell, for numbering.
    h.order = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ax = h.x + dx, ay = h.y + dy;
        if (ax < 0 || ay < 0 || ax >= cols || ay >= rows) continue;
        const pi = pathIndex[at(ax, ay)];
        if (pi >= 0) h.order = Math.min(h.order, pi);
      }
    }
  }
  holes.forEach((h) => { h.x += h.ox; h.y += h.oy; });
  holes
    .filter((h) => h.order < Infinity)
    .sort((a, b) => a.order - b.order || a.y - b.y || a.x - b.x)
    .forEach((h, i) => { h.num = i + 1; });

  // --- Label placement: the free spot farthest from line, blocks and holes ---
  const clearance = (px, py, self) => {
    let d = Infinity;
    for (let k = 1; k < path.length; k++) {
      d = Math.min(d, segDist(px, py, path[k - 1][0], path[k - 1][1], path[k][0], path[k][1]));
    }
    for (const w of walls) {
      const hl = WALL_LEN / 2;
      d = Math.min(d, w.horizontal
        ? segDist(px, py, w.x - hl, w.y, w.x + hl, w.y)
        : segDist(px, py, w.x, w.y - hl, w.x, w.y + hl));
    }
    for (const h of holes) if (h !== self) d = Math.min(d, Math.hypot(px - h.x, py - h.y) - 0.3);
    d = Math.min(d, px + 0.5, py + 0.5, cols - 0.5 - px, rows - 0.5 - py);
    return d;
  };
  const place = (cx, cy, r, self) => {
    let bestPt = { x: cx + r, y: cy - r }, bestD = -Infinity;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2 - Math.PI / 4;
      const px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
      const d = clearance(px, py, self);
      if (d > bestD) { bestD = d; bestPt = { x: px, y: py }; }
    }
    return bestPt;
  };
  for (const h of holes) if (h.num) h.label = place(h.x, h.y, 0.5, h);

  return {
    level, cols, rows, path, holes, walls, seal,
    start: { x: sx, y: sy },
    goal: { x: gx, y: gy },
    startLabel: place(sx, sy, 0.62),
    goalLabel: place(gx, gy, 0.68),
  };
}
