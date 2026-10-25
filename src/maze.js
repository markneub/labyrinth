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

export function generateLevel(level) {
  const rng = mulberry32(level * 7919 + 101);
  const mc = level <= 3 ? 5 : 6;
  const mr = level <= 3 ? 5 : 6;
  const cols = mc * 2 + 1, rows = mr * 2 + 1;

  // --- Route: deepest branch of a recursive-backtracker maze on the nodes ---
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
  // Finish as deep as possible, preferring the rim of the board.
  let endNode = startNode, best = -1;
  for (let n = 0; n < mc * mr; n++) {
    const i = n % mc, j = (n / mc) | 0;
    const rim = i === 0 || j === 0 || i === mc - 1 || j === mr - 1;
    const score = depth[n] + (rim ? 3 : 0);
    if (score > best) { best = score; endNode = n; }
  }
  const nodes = [];
  for (let n = endNode; n >= 0; n = parent[n]) nodes.unshift([(n % mc) * 2 + 1, ((n / mc) | 0) * 2 + 1]);

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
    level, cols, rows, path, holes, walls,
    start: { x: sx, y: sy },
    goal: { x: gx, y: gy },
    startLabel: place(sx, sy, 0.62),
    goalLabel: place(gx, gy, 0.68),
  };
}
