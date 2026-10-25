import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { generateLevel, WALL_LEN } from './maze.js';
import { loadWoodMaps, makeBoardTexture, makeWoodTexture } from './textures.js';
import { TiltInput } from './input.js';
import { Sfx } from './audio.js';

// --- Dimensions (1 unit ≈ 1.4 cm) ---
const CELL = 1.3;
const WALL_T = 0.24;
const WALL_H = 0.5;
const BALL_R = 0.3;
const HOLE_R = 0.42;
const BOARD_T = 0.3;
const RIM_T = 0.3;            // the board's own raised border
const RIM_H = 0.5;
const GAP = 0.12;
const GIMBAL_T = 0.45;        // inner frame that tilts on one axis
const BOX_T = 0.55;           // outer box
const BOX_TOP = 0.9;
const BOX_BOTTOM = -2.8;
const BOX_FLOOR = -2.5;       // inside of the box, where fallen balls land

// --- Physics ---
const GRAVITY = 170;
const ROLL = 5 / 7;           // solid sphere rolling without slipping
const MAX_TILT = THREE.MathUtils.degToRad(18);
const DAMPING = 0.35;         // air + rolling losses, per second
const ROLL_RESIST = 1.2;      // constant deceleration, keeps the ball from creeping
const RESTITUTION = 0.38;
const HOLE_PULL = 70;
const MAX_SPEED = 22;
const SUBSTEPS = 6;

const CAMERA_ANGLE = THREE.MathUtils.degToRad(24);
const ZOOM_MAX = 1.7;         // magnification toward the ball at full tilt
const ZOOM_RATE = 2.5;        // per second; slow enough not to pump on small wobbles

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
  },
};

// --- Renderer & scene ---
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2ede6);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8c4a4, 0.8));
const sun = new THREE.DirectionalLight(0xfff6e8, 2.0);
sun.position.set(-12, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// Product-shot floor the box stands on.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0xf2ede6, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = BOX_BOTTOM;
ground.receiveShadow = true;
scene.add(ground);

// The board tilts inside the box like the real thing: the gimbal frame on
// one axis, the board within it on the other.
const gimbal = new THREE.Group();
const boardPivot = new THREE.Group();
gimbal.add(boardPivot);
scene.add(gimbal);

const anisotropy = renderer.capabilities.getMaxAnisotropy();

// Poly Haven wood maps, filled in by init(); procedural wood if they fail to load.
let woodMaps = null;    // blocks, rim, frame and box: { albedo, normal, rough }
let boardMaps = null;   // playing surface
let fallbackWood = null;
let blockMats = [];

/** Wood for a part `length` units long, grain running along it. */
function woodMaterial(length, { tint = 1, offset = 0 } = {}) {
  const tile = (t) => {
    const c = t.clone();
    c.repeat.set(Math.max(length / 9, 0.12), 0.2);
    c.offset.set(offset, offset * 0.37);
    c.needsUpdate = true;
    return c;
  };
  const color = woodMaps ? new THREE.Color(tint, tint * 0.9, tint * 0.74) : new THREE.Color(tint, tint * 0.99, tint * 0.97);
  if (!woodMaps) return new THREE.MeshStandardMaterial({ map: tile(fallbackWood), color, roughness: 0.65 });
  return new THREE.MeshStandardMaterial({
    map: tile(woodMaps.albedo),
    normalMap: tile(woodMaps.normal),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap: tile(woodMaps.rough),
    color,
  });
}

const ball = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 48, 32),
  new THREE.MeshStandardMaterial({ color: 0xe8e8ec, metalness: 1, roughness: 0.12, envMapIntensity: 1.7 }),
);
ball.castShadow = true;
boardPivot.add(ball);

const input = new TiltInput(canvas, MAX_TILT);
const sfx = new Sfx();

const game = {
  level: store.get('labyrinth.level', 1),
  layout: null,
  cam: null,         // fitted framing: { dir, target, dist, halfX, halfZ }
  groups: [],
  knobs: null,
  state: 'menu',      // menu | play | fall | won
  p: { x: 0, z: 0 },
  v: { x: 0, z: 0 },
  fall: null,
  spawn: 1,
  time: 0,
  timing: false,
  falls: 0,
  lastVibe: 0,
};

// --- Level construction ---
function slab(parent, b, y0, y1, material, radius = 0.05) {
  const sx = b.maxx - b.minx, sz = b.maxz - b.minz;
  const alongZ = sz > sx;
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(Math.max(sx, sz), y1 - y0, Math.min(sx, sz), 2, radius),
    material,
  );
  if (alongZ) mesh.rotation.y = Math.PI / 2;
  mesh.position.set((b.minx + b.maxx) / 2, (y0 + y1) / 2, (b.minz + b.maxz) / 2);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Four slabs framing a rectangle; the front and back ones own the corners. */
function ring(half, thick) {
  const { x, z } = half;
  return [
    { minx: -x - thick, maxx: x + thick, minz: -z - thick, maxz: -z },
    { minx: -x - thick, maxx: x + thick, minz: z, maxz: z + thick },
    { minx: -x - thick, maxx: -x, minz: -z, maxz: z },
    { minx: x, maxx: x + thick, minz: -z, maxz: z },
  ];
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [].concat(o.material)) {
      if (blockMats.includes(m)) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap']) m[key]?.dispose();
      m.dispose();
    }
  });
  group.removeFromParent();
}

function makeKnob() {
  const knob = new THREE.Group();
  const mat = woodMaterial(2);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.4, 20), mat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.2;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 20), mat);
  head.scale.z = 0.8;
  head.position.z = 0.62;
  for (const m of [shaft, head]) { m.castShadow = m.receiveShadow = true; knob.add(m); }
  return knob;
}

function buildLevel(level) {
  for (const g of game.groups) disposeGroup(g);
  const maze = generateLevel(level);
  const W = maze.cols * CELL, H = maze.rows * CELL;
  const toW = (p) => ({ x: -W / 2 + (p.x + 0.5) * CELL, z: -H / 2 + (p.y + 0.5) * CELL });

  const holes = maze.holes.map((h) => ({ ...toW(h), num: h.num, label: h.label && toW(h.label), goal: false }));
  const goal = { ...toW(maze.goal), goal: true };
  const start = toW(maze.start);
  const path = maze.path.map(([x, y]) => toW({ x, y }));

  // ---- Board (tilts on both axes) ----
  const board = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, -H / 2);
  shape.lineTo(W / 2, -H / 2);
  shape.lineTo(W / 2, H / 2);
  shape.lineTo(-W / 2, H / 2);
  shape.closePath();
  for (const h of [...holes, goal]) {
    const p = new THREE.Path();
    p.absarc(h.x, -h.z, HOLE_R, 0, Math.PI * 2, true);
    shape.holes.push(p);
  }
  const ppu = Math.min(96, Math.floor(2048 / Math.max(W, H)));
  const boardTex = makeBoardTexture({
    W, H, ppu, cell: CELL, path, holes, goal, holeR: HOLE_R,
    startLabel: toW(maze.startLabel), goalLabel: toW(maze.goalLabel),
    wood: boardMaps?.albedo.image,
  }, anisotropy);
  // The top face's UVs are shape coordinates; map the board's extent to 0..1.
  const fit = (t) => {
    t.repeat.set(1 / W, 1 / H);
    t.offset.set(0.5, 0.5);
    return t;
  };
  const top = boardMaps
    ? new THREE.MeshStandardMaterial({
      map: fit(boardTex),
      normalMap: fit(boardMaps.normal.clone()),
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughnessMap: fit(boardMaps.rough.clone()),
    })
    : new THREE.MeshStandardMaterial({ map: fit(boardTex), roughness: 0.6 });
  const surface = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: BOARD_T, bevelEnabled: false, curveSegments: 28 }),
    [
      top,
      new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.9 }),
    ],
  );
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = -BOARD_T;
  surface.receiveShadow = true;
  board.add(surface);

  const boxes = [];
  maze.walls.forEach((w, i) => {
    const c = toW(w);
    const hl = (WALL_LEN * CELL) / 2, ht = WALL_T / 2;
    const b = w.horizontal
      ? { minx: c.x - hl, maxx: c.x + hl, minz: c.z - ht, maxz: c.z + ht }
      : { minx: c.x - ht, maxx: c.x + ht, minz: c.z - hl, maxz: c.z + hl };
    boxes.push(b);
    slab(board, b, 0, WALL_H, blockMats[i % blockMats.length], 0.04);
  });
  for (const b of ring({ x: W / 2, z: H / 2 }, RIM_T)) {
    boxes.push(b);
    slab(board, b, -BOARD_T, RIM_H, woodMaterial(W), 0.04);
  }
  boardPivot.add(board);

  // ---- Gimbal frame (tilts on one axis) ----
  const frame = new THREE.Group();
  const fIn = { x: W / 2 + RIM_T + GAP, z: H / 2 + RIM_T + GAP };
  for (const b of ring(fIn, GIMBAL_T)) slab(frame, b, -BOARD_T - 0.3, 0.2, woodMaterial(W), 0.05);
  gimbal.add(frame);

  // ---- Outer box (static) ----
  const box = new THREE.Group();
  const bIn = { x: fIn.x + GIMBAL_T + GAP, z: fIn.z + GIMBAL_T + GAP };
  const OX = bIn.x + BOX_T, OZ = bIn.z + BOX_T;
  for (const b of ring(bIn, BOX_T)) slab(box, b, BOX_BOTTOM, BOX_TOP, woodMaterial(2 * OX), 0.07);
  // Dark interior so holes read as holes.
  const inside = new THREE.Mesh(
    new THREE.PlaneGeometry(bIn.x * 2, bIn.z * 2),
    new THREE.MeshBasicMaterial({ color: 0x1c140e }),
  );
  inside.rotation.x = -Math.PI / 2;
  inside.position.y = BOX_FLOOR;
  box.add(inside);

  const knobY = (BOX_BOTTOM + BOX_TOP) / 2 - 0.1;
  const front = makeKnob();
  front.position.set(0, knobY, OZ);
  const side = makeKnob();
  side.rotation.y = Math.PI / 2;
  side.position.set(OX, knobY, 0);
  box.add(front, side);
  game.knobs = { front, side };

  // Ball-return tray at the front corner.
  const tray = slab(box, { minx: OX - 2.0, maxx: OX - 0.3, minz: OZ, maxz: OZ + 1.0 }, BOX_BOTTOM, BOX_BOTTOM + 0.7, woodMaterial(2), 0.08);
  const dish = new THREE.Mesh(
    new THREE.CircleGeometry(0.42, 32),
    new THREE.MeshStandardMaterial({ color: 0xc9a273, roughness: 0.8 }),
  );
  dish.rotation.x = -Math.PI / 2;
  dish.position.set(tray.position.x, BOX_BOTTOM + 0.705, tray.position.z);
  box.add(dish);
  scene.add(box);

  game.groups = [board, frame, box];
  game.layout = {
    W, H, boxes, holes: [...holes, goal], start, maze,
    extents: [
      ...[-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [BOX_TOP, BOX_BOTTOM].map(
        (y) => new THREE.Vector3(sx * OX, y, sz * (OZ + (sz > 0 ? 1.0 : 0))),
      ))),
      new THREE.Vector3(0, knobY, OZ + 1.0),
      new THREE.Vector3(OX + 1.0, knobY, 0),
    ],
  };

  const ext = Math.max(OX, OZ) + 2;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 90 });
  sun.shadow.camera.updateProjectionMatrix();

  fitCamera();
  resetRun();
  $('hud-level').textContent = `Level ${level}`;
}

/** Frame the whole box in the space left by the HUD, at a fixed viewing angle. */
function fitCamera() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
  if (!game.layout) return;
  const top = 64, bottom = 20, sides = 14;
  const limX = 1 - (2 * sides) / w, limY = 1 - (top + bottom) / h;
  const dir = new THREE.Vector3(0, Math.cos(CAMERA_ANGLE), Math.sin(CAMERA_ANGLE));
  const target = new THREE.Vector3(0, (BOX_TOP + BOX_BOTTOM) / 2, 0);
  const v = new THREE.Vector3();
  const measure = (d) => {
    camera.position.copy(dir).multiplyScalar(d).add(target);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of game.layout.extents) {
      v.copy(p).project(camera);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    return { x0, x1, y0, y1 };
  };
  let lo = 2, hi = 300;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, m = measure(mid);
    if ((m.x1 - m.x0) / 2 <= limX && (m.y1 - m.y0) / 2 <= limY) hi = mid;
    else lo = mid;
  }
  const m = measure(hi);
  // Shift the image so the box sits centred in the free area.
  const wantY = (bottom - top) / h;
  const shiftY = (wantY - (m.y0 + m.y1) / 2) * (h / 2);
  const shiftX = ((m.x0 + m.x1) / 2) * (w / 2);
  camera.setViewOffset(w, h, shiftX, shiftY, w, h);
  camera.updateProjectionMatrix();
  game.cam = { dir, target, dist: hi, halfX: game.layout.W / 2, halfZ: game.layout.H / 2 };
  updateCamera(0);
}
addEventListener('resize', fitCamera);

// Lean in toward the ball the harder the board is tilted; ease back out as it levels.
const zoom = { amount: 0, focus: new THREE.Vector3(), ball: new THREE.Vector3() };
function updateCamera(dt) {
  const cam = game.cam;
  if (!cam) return;
  const lean = Math.hypot(input.tilt.x, input.tilt.z) / MAX_TILT;
  const active = game.state === 'play' || game.state === 'fall';
  const want = active ? THREE.MathUtils.smoothstep(lean, 0.15, 0.8) : 0;
  zoom.amount += (want - zoom.amount) * (1 - Math.exp(-dt * ZOOM_RATE));
  const f = 1 + (ZOOM_MAX - 1) * zoom.amount;
  // Follow the ball, but stop short of showing past the board's edges.
  ball.getWorldPosition(zoom.ball);
  const lim = 1 - 1 / f;
  zoom.ball.set(
    clamp(zoom.ball.x, -cam.halfX * lim, cam.halfX * lim),
    0,
    clamp(zoom.ball.z, -cam.halfZ * lim, cam.halfZ * lim),
  );
  zoom.focus.copy(cam.target).lerp(zoom.ball, zoom.amount);
  camera.position.copy(cam.dir).multiplyScalar(cam.dist / f).add(zoom.focus);
  camera.lookAt(zoom.focus);
}

// --- Run state ---
function placeAtStart() {
  const { start } = game.layout;
  game.p.x = start.x;
  game.p.z = start.z;
  game.v.x = game.v.z = 0;
  game.spawn = 0;
}

function resetRun() {
  placeAtStart();
  game.time = 0;
  game.timing = false;
  game.falls = 0;
  game.fall = null;
  if (game.state !== 'menu') game.state = 'play';
  updateHud(true);
}

function startFall(hole) {
  game.state = 'fall';
  game.fall = { hole, y: BALL_R, vy: 0, t: 0 };
  if (hole.goal) {
    game.timing = false;
    sfx.win();
    navigator.vibrate?.([20, 40, 20, 40, 60]);
  } else {
    sfx.fall();
    navigator.vibrate?.(60);
  }
}

function updateFall(dt) {
  const f = game.fall;
  f.t += dt;
  const k = 1 - Math.exp(-dt * 16);
  game.p.x += (f.hole.x - game.p.x) * k;
  game.p.z += (f.hole.z - game.p.z) * k;
  if (f.t > 0.06) {
    f.vy -= 45 * dt;
    f.y = Math.max(f.y + f.vy * dt, BOX_FLOOR + BALL_R);
  }
  if (f.t < 0.9) return;
  if (f.hole.goal) {
    win();
  } else {
    game.falls++;
    game.state = 'play';
    game.fall = null;
    placeAtStart();
  }
}

function win() {
  game.state = 'won';
  game.fall = null;
  const key = `labyrinth.best.${game.level}`;
  const best = store.get(key, null);
  const isBest = best == null || game.time < best;
  if (isBest) store.set(key, game.time);
  store.set('labyrinth.level', Math.max(store.get('labyrinth.level', 1), game.level + 1));
  $('win-time').textContent = fmtTime(game.time);
  $('win-detail').textContent =
    `${game.falls} ${game.falls === 1 ? 'fall' : 'falls'} · ` +
    (isBest ? 'New best!' : `Best ${fmtTime(best)}`);
  show('overlay-win');
}

// --- Physics ---
function collide() {
  const { p, v } = game;
  let impact = 0;
  for (const b of game.layout.boxes) {
    const cx = clamp(p.x, b.minx, b.maxx), cz = clamp(p.z, b.minz, b.maxz);
    const dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= BALL_R * BALL_R) continue;
    let nx, nz, pen;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nx = dx / d; nz = dz / d; pen = BALL_R - d;
    } else {
      // Centre ended up inside the box: leave by the nearest face.
      const faces = [
        [p.x - b.minx, -1, 0], [b.maxx - p.x, 1, 0],
        [p.z - b.minz, 0, -1], [b.maxz - p.z, 0, 1],
      ].sort((a, c) => a[0] - c[0]);
      [pen, nx, nz] = faces[0];
      pen += BALL_R;
    }
    p.x += nx * pen;
    p.z += nz * pen;
    const vn = v.x * nx + v.z * nz;
    if (vn < 0) {
      // Resting contact shouldn't bounce or jitter.
      const e = -vn > 0.6 ? RESTITUTION : 0;
      v.x -= (1 + e) * vn * nx;
      v.z -= (1 + e) * vn * nz;
      const vt = -v.x * nz + v.z * nx;
      v.x -= vt * 0.04 * -nz;
      v.z -= vt * 0.04 * nx;
      impact = Math.max(impact, -vn);
    }
  }
  return impact;
}

function step(dt) {
  const { p, v } = game;
  const ax = GRAVITY * ROLL * Math.sin(input.tilt.x);
  const az = GRAVITY * ROLL * Math.sin(input.tilt.z);
  const h = dt / SUBSTEPS;
  let impact = 0;
  for (let i = 0; i < SUBSTEPS; i++) {
    v.x += ax * h;
    v.z += az * h;
    for (const hole of game.layout.holes) {
      const dx = hole.x - p.x, dz = hole.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d >= HOLE_R) continue;
      if (d < HOLE_R * 0.72) { startFall(hole); return impact; }
      // Rolling over the lip pulls the ball in.
      const pull = HOLE_PULL * (1 - d / HOLE_R) * h;
      v.x += (dx / d) * pull;
      v.z += (dz / d) * pull;
    }
    const damp = Math.exp(-DAMPING * h);
    const speed = Math.hypot(v.x, v.z) * damp;
    const s2 = clamp(speed - ROLL_RESIST * h, 0, MAX_SPEED);
    const f = speed > 1e-6 ? (s2 / speed) * damp : 0;
    v.x *= f;
    v.z *= f;
    p.x += v.x * h;
    p.z += v.z * h;
    impact = Math.max(impact, collide());
  }
  return impact;
}

// --- HUD & overlays ---
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

let hudCache = '';
function updateHud(force) {
  const text = `${fmtTime(game.time)}|${game.falls}`;
  if (!force && text === hudCache) return;
  hudCache = text;
  $('hud-time').textContent = fmtTime(game.time);
  $('hud-falls').textContent = `${game.falls} ${game.falls === 1 ? 'fall' : 'falls'}`;
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), ms);
}

async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch { /* not supported or denied */ }
}
// The browser drops the wake lock whenever the page is hidden.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && game.state !== 'menu') keepAwake();
});

const touchDevice = matchMedia('(pointer: coarse)').matches;
if (touchDevice && !isSecureContext) {
  $('start-note').textContent = 'Tilt controls need HTTPS. Open this page over https:// to use the motion sensor.';
}
$('start-level').textContent = game.level > 1 ? `Continue at level ${game.level}` : '';

$('btn-play').addEventListener('click', async () => {
  sfx.init();
  const sensorsP = input.enableSensors();  // must start inside the tap for iOS
  hide('overlay-start');
  game.state = 'play';
  resetRun();
  keepAwake();
  input.calibrate();
  const ok = await sensorsP;
  setTimeout(() => {
    if (input.sensor) toast('Tilt to roll. Tap ◎ to reset level.');
    else toast(touchDevice ? 'No tilt sensor: drag on the board to tilt it.' : 'Use arrow keys / WASD, or drag the board.', 3500);
  }, ok ? 800 : 0);
});

$('btn-next').addEventListener('click', () => {
  hide('overlay-win');
  game.level++;
  game.state = 'play';
  buildLevel(game.level);
});

$('btn-replay').addEventListener('click', () => {
  hide('overlay-win');
  game.state = 'play';
  resetRun();
});

$('btn-restart').addEventListener('click', () => {
  if (game.state === 'menu' || game.state === 'won') return;
  game.state = 'play';
  resetRun();
});

$('btn-calibrate').addEventListener('click', () => {
  input.calibrate();
  toast(input.sensor ? 'Level set to how you are holding the phone.' : 'No tilt sensor detected.');
});

// --- Main loop ---
const clock = new THREE.Clock();
const spin = new THREE.Quaternion();
const axis = new THREE.Vector3();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 30);
  input.update(dt);

  let speed = 0;
  if (game.state === 'play') {
    const impact = step(dt);
    speed = Math.hypot(game.v.x, game.v.z);
    if (impact > 1.2) {
      sfx.hit(Math.min(impact / 14, 1));
      const now = performance.now();
      if (impact > 5 && now - game.lastVibe > 90) {
        navigator.vibrate?.(Math.min(25, Math.round(impact * 1.5)));
        game.lastVibe = now;
      }
    }
    if (!game.timing && speed > 0.3) game.timing = true;
  } else if (game.state === 'fall') {
    updateFall(dt);
  }
  if (game.timing && (game.state === 'play' || game.state === 'fall')) game.time += dt;
  sfx.roll(game.state === 'play' ? speed : 0);

  // Roll the ball mesh to match its travel.
  if (speed > 1e-4) {
    axis.set(game.v.z, 0, -game.v.x).normalize();
    spin.setFromAxisAngle(axis, (speed * dt) / BALL_R);
    ball.quaternion.premultiply(spin);
  }
  game.spawn = Math.min(1, game.spawn + dt * 5);
  const y = game.fall ? game.fall.y : BALL_R;
  ball.position.set(game.p.x, y, game.p.z);
  ball.scale.setScalar(0.4 + 0.6 * game.spawn);

  // The phone itself is tilting, so keep the on-screen tilt subtle there.
  const visual = input.sensor ? 0.3 : 0.55;
  gimbal.rotation.x = input.tilt.z * visual;
  boardPivot.rotation.z = -input.tilt.x * visual;
  // Knobs turn with the axis they drive.
  if (game.knobs) {
    game.knobs.front.rotation.z = boardPivot.rotation.z * 6;
    game.knobs.side.rotation.x = gimbal.rotation.x * 6;
  }

  updateCamera(dt);
  updateHud();
  renderer.render(scene, camera);
});

async function init() {
  try {
    const maps = await loadWoodMaps(import.meta.env.BASE_URL, anisotropy);
    woodMaps = maps.wood;
    boardMaps = maps.board;
  } catch (err) {
    console.warn('Wood textures failed to load; using procedural wood.', err);
    fallbackWood = makeWoodTexture(512, 96, { light: [230, 196, 142], dark: [204, 162, 104], seed: 7, scale: 1.2 }, anisotropy);
  }
  blockMats = [1, 0.97, 0.93, 1.03].map((tint, i) => woodMaterial(WALL_LEN * CELL, { tint, offset: i * 0.29 }));
  buildLevel(game.level);
  const play = $('btn-play');
  play.disabled = false;
  play.textContent = 'Play';
}

init();
