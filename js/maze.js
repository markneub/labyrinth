// Procedural maze + hole layout. Every level number always produces the same
// board, so best times stay comparable.

export const N = 1, E = 2, S = 4, W = 8;

const DIRS = [
  { bit: N, dc: 0, dr: -1, opp: S },
  { bit: E, dc: 1, dr: 0, opp: W },
  { bit: S, dc: 0, dr: 1, opp: N },
  { bit: W, dc: -1, dr: 0, opp: E },
];

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

const popcount = (m) => ((m & N) && 1) + ((m & E) && 1) + ((m & S) && 1) + ((m & W) && 1);

/**
 * cells[r * cols + c] is a bitmask of open sides (N/E/S/W).
 * Hole offsets (ox, oy) are fractions of a cell, relative to the cell centre.
 */
export function generateLevel(level) {
  const rng = mulberry32(level * 7919 + 101);
  const cols = Math.min(4 + Math.ceil(level / 2), 9);
  const rows = Math.min(Math.round(cols * 1.65), 14);
  const cells = new Uint8Array(cols * rows);
  const idx = (c, r) => r * cols + c;

  // Recursive backtracker (iterative) from the top-left corner.
  const visited = new Uint8Array(cols * rows);
  const stack = [0];
  visited[0] = 1;
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const c = cur % cols, r = (cur / cols) | 0;
    const options = shuffle(DIRS.slice(), rng).filter((d) => {
      const nc = c + d.dc, nr = r + d.dr;
      return nc >= 0 && nr >= 0 && nc < cols && nr < rows && !visited[idx(nc, nr)];
    });
    if (!options.length) { stack.pop(); continue; }
    const d = options[0];
    const next = idx(c + d.dc, r + d.dr);
    cells[cur] |= d.bit;
    cells[next] |= d.opp;
    visited[next] = 1;
    stack.push(next);
  }

  // Later levels get a few loops so there is more than one way through.
  let loops = Math.max(0, Math.min(level - 3, 6));
  for (let tries = 0; loops > 0 && tries < 200; tries++) {
    const c = Math.floor(rng() * (cols - 1)), r = Math.floor(rng() * (rows - 1));
    const d = rng() < 0.5 ? DIRS[1] : DIRS[2];
    if (cells[idx(c, r)] & d.bit) continue;
    cells[idx(c, r)] |= d.bit;
    cells[idx(c + d.dc, r + d.dr)] |= d.opp;
    loops--;
  }

  // BFS from the start for the shortest route.
  const dist = new Int32Array(cols * rows).fill(-1);
  const prev = new Int32Array(cols * rows).fill(-1);
  const queue = [0];
  dist[0] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const c = cur % cols, r = (cur / cols) | 0;
    for (const d of DIRS) {
      if (!(cells[cur] & d.bit)) continue;
      const n = idx(c + d.dc, r + d.dr);
      if (dist[n] >= 0) continue;
      dist[n] = dist[cur] + 1;
      prev[n] = cur;
      queue.push(n);
    }
  }

  // Finish on the bottom row, as far from the start as possible.
  let goalIdx = idx(cols - 1, rows - 1);
  for (let c = 0; c < cols; c++) {
    if (dist[idx(c, rows - 1)] > dist[goalIdx]) goalIdx = idx(c, rows - 1);
  }
  const pathIdx = [];
  for (let n = goalIdx; n >= 0; n = prev[n]) pathIdx.unshift(n);
  const path = pathIdx.map((n) => [n % cols, (n / cols) | 0]);
  const onPath = new Set(pathIdx);

  const holes = [];

  // Holes along the route, tucked to one side so a careful player can pass.
  const pathChance = Math.min(0.3 + level * 0.06, 0.7);
  let lastHole = -10;
  for (let i = 2; i < path.length - 1; i++) {
    if (i - lastHole < 2 || rng() > pathChance) continue;
    const [pc, pr] = path[i - 1], [c, r] = path[i], [nc, nr] = path[i + 1];
    const din = [c - pc, r - pr], dout = [nc - c, nr - r];
    let ox, oy;
    if (din[0] === dout[0] && din[1] === dout[1]) {
      const s = rng() < 0.5 ? 1 : -1;
      ox = -din[1] * s * 0.23;
      oy = din[0] * s * 0.23;
    } else {
      // Outside corner of the turn, where momentum carries the ball.
      ox = (din[0] - dout[0]) * 0.2;
      oy = (din[1] - dout[1]) * 0.2;
    }
    holes.push({ c, r, ox, oy, onPath: true });
    lastHole = i;
  }

  // Dead ends and side branches are traps.
  for (let n = 1; n < cells.length; n++) {
    if (onPath.has(n)) continue;
    const c = n % cols, r = (n / cols) | 0;
    if (popcount(cells[n]) === 1 || rng() < 0.2) {
      holes.push({ c, r, ox: (rng() - 0.5) * 0.12, oy: (rng() - 0.5) * 0.12, onPath: false });
    }
  }

  // Number the route holes in travel order, like the classic boards.
  const order = new Map(pathIdx.map((n, i) => [n, i]));
  holes
    .filter((h) => h.onPath)
    .sort((a, b) => order.get(idx(a.c, a.r)) - order.get(idx(b.c, b.r)))
    .forEach((h, i) => { h.num = i + 1; });

  return {
    level, cols, rows, cells, path, holes,
    goal: { c: goalIdx % cols, r: (goalIdx / cols) | 0 },
  };
}

/** Internal walls as merged runs along grid lines (outer edges are the frame). */
export function wallSegments({ cols, rows, cells }) {
  const segs = [];
  for (let r = 1; r < rows; r++) {
    let run = -1;
    for (let c = 0; c <= cols; c++) {
      const wall = c < cols && !(cells[(r - 1) * cols + c] & S);
      if (wall && run < 0) run = c;
      if (!wall && run >= 0) { segs.push({ x0: run, x1: c, z0: r, z1: r }); run = -1; }
    }
  }
  for (let c = 1; c < cols; c++) {
    let run = -1;
    for (let r = 0; r <= rows; r++) {
      const wall = r < rows && !(cells[r * cols + c - 1] & E);
      if (wall && run < 0) run = r;
      if (!wall && run >= 0) { segs.push({ x0: c, x1: c, z0: run, z1: r }); run = -1; }
    }
  }
  return segs;
}
