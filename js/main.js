import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { generateLevel, wallSegments } from './maze.js';
import { makeBoardTexture, makeWoodTexture } from './textures.js';
import { TiltInput } from './input.js';
import { Sfx } from './audio.js';

// --- Dimensions (1 unit ≈ 2.5 cm) ---
const CELL = 2.4;
const WALL_T = 0.24;
const WALL_H = 0.55;
const BALL_R = 0.3;
const HOLE_R = 0.42;
const FRAME_T = 0.8;
const FRAME_H = 1.0;
const BOARD_T = 0.3;
const TRAY_DEPTH = 2.4;

// --- Physics ---
const GRAVITY = 200;
const ROLL = 5 / 7;           // solid sphere rolling without slipping
const MAX_TILT = THREE.MathUtils.degToRad(18);
const DAMPING = 0.35;         // air + rolling losses, per second
const ROLL_RESIST = 1.2;      // constant deceleration, keeps the ball from creeping
const RESTITUTION = 0.38;
const HOLE_PULL = 70;
const MAX_SPEED = 26;
const SUBSTEPS = 6;

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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15100c);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2a1a10, 0.7));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.position.set(-8, 30, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const pivot = new THREE.Group();   // tilts with the input for visual feedback
scene.add(pivot);

const anisotropy = renderer.capabilities.getMaxAnisotropy();
const wallTex = makeWoodTexture(512, 64, { light: [214, 170, 118], dark: [150, 100, 58], seed: 7, scale: 1.2 }, anisotropy);
const frameTex = makeWoodTexture(1024, 128, { light: [122, 74, 42], dark: [60, 33, 18], seed: 3, scale: 1.6 }, anisotropy);

const ball = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 48, 32),
  new THREE.MeshStandardMaterial({ color: 0xe8e8ec, metalness: 1, roughness: 0.14, envMapIntensity: 1.6 }),
);
ball.castShadow = true;
pivot.add(ball);

const input = new TiltInput(canvas, MAX_TILT);
const sfx = new Sfx();

const game = {
  level: store.get('labyrinth.level', 1),
  layout: null,
  group: null,
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
function block(group, b, y0, y1, tex) {
  const sx = b.maxx - b.minx, sz = b.maxz - b.minz;
  const alongZ = sz > sx;
  const len = Math.max(sx, sz);
  const map = tex.clone();
  map.repeat.set(len / 6, 1);
  map.needsUpdate = true;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(len, y1 - y0, Math.min(sx, sz)),
    new THREE.MeshStandardMaterial({ map, roughness: 0.6 }),
  );
  if (alongZ) mesh.rotation.y = Math.PI / 2;
  mesh.position.set((b.minx + b.maxx) / 2, (y0 + y1) / 2, (b.minz + b.maxz) / 2);
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [].concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}

function buildLevel(level) {
  if (game.group) {
    disposeGroup(game.group);
    pivot.remove(game.group);
  }
  const maze = generateLevel(level);
  const W = maze.cols * CELL, H = maze.rows * CELL;
  const at = (c, r, ox = 0, oy = 0) => ({
    x: -W / 2 + (c + 0.5 + ox) * CELL,
    z: -H / 2 + (r + 0.5 + oy) * CELL,
  });

  const holes = maze.holes.map((h) => {
    const pos = at(h.c, h.r, h.ox, h.oy);
    // Number sits beside the hole, perpendicular to its offset from the line.
    const len = Math.hypot(h.ox, h.oy) || 1;
    const k = (HOLE_R + 0.24) / len;
    return { ...pos, num: h.num, goal: false, label: { x: pos.x - h.oy * k, z: pos.z + h.ox * k } };
  });
  const goal = { ...at(maze.goal.c, maze.goal.r), goal: true };
  const start = at(0, 0);
  const path = maze.path.map(([c, r]) => at(c, r));

  const group = new THREE.Group();

  // Board with real cut-outs so the ball can drop through.
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
  const ppu = Math.min(64, Math.floor(2048 / Math.max(W, H)));
  const boardTex = makeBoardTexture({ W, H, ppu, path, holes, goal, start, holeR: HOLE_R }, anisotropy);
  boardTex.repeat.set(1 / W, 1 / H);
  boardTex.offset.set(0.5, 0.5);
  const board = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: BOARD_T, bevelEnabled: false, curveSegments: 28 }),
    [
      new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.55 }),
      new THREE.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.9 }),
    ],
  );
  board.rotation.x = -Math.PI / 2;
  board.position.y = -BOARD_T;
  board.receiveShadow = true;
  group.add(board);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ color: 0x0d0805, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -TRAY_DEPTH;
  group.add(floor);

  // Brass ring around the finish hole.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(HOLE_R + 0.05, 0.06, 12, 48),
    new THREE.MeshStandardMaterial({ color: 0xd4a540, metalness: 1, roughness: 0.3 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(goal.x, 0.0, goal.z);
  ring.castShadow = true;
  group.add(ring);

  const boxes = [];
  for (const s of wallSegments(maze)) {
    const b = {
      minx: -W / 2 + s.x0 * CELL - WALL_T / 2,
      maxx: -W / 2 + s.x1 * CELL + WALL_T / 2,
      minz: -H / 2 + s.z0 * CELL - WALL_T / 2,
      maxz: -H / 2 + s.z1 * CELL + WALL_T / 2,
    };
    boxes.push(b);
    block(group, b, 0, WALL_H, wallTex);
  }
  const ft = FRAME_T, frame = [
    { minx: -W / 2 - ft, maxx: -W / 2, minz: -H / 2 - ft, maxz: H / 2 + ft },
    { minx: W / 2, maxx: W / 2 + ft, minz: -H / 2 - ft, maxz: H / 2 + ft },
    { minx: -W / 2, maxx: W / 2, minz: -H / 2 - ft, maxz: -H / 2 },
    { minx: -W / 2, maxx: W / 2, minz: H / 2, maxz: H / 2 + ft },
  ];
  for (const b of frame) {
    boxes.push(b);
    block(group, b, -TRAY_DEPTH - 0.2, FRAME_H, frameTex);
  }

  pivot.add(group);
  game.group = group;
  game.layout = { W, H, boxes, holes: [...holes, goal], start, maze };

  const ext = Math.max(W, H) / 2 + FRAME_T + 1;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();

  fitCamera();
  resetRun();
  $('hud-level').textContent = `Level ${level}`;
}

function fitCamera() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (!game.layout) return;
  const halfW = game.layout.W / 2 + FRAME_T + 0.3;
  const halfH = game.layout.H / 2 + FRAME_T + 0.3;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const hudPad = 1 + 140 / h;  // leave room for the HUD bar
  const dist = Math.max((halfH * hudPad) / t, halfW / (t * camera.aspect)) + FRAME_H;
  const ang = THREE.MathUtils.degToRad(8);
  camera.position.set(0, dist * Math.cos(ang), dist * Math.sin(ang));
  camera.lookAt(0, 0, -halfH * (hudPad - 1) * 0.5);
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitCamera);

// --- Run state ---
function placeAtStart() {
  const { start } = game.layout;
  game.p.x = start.x;
  game.p.z = start.z;
  game.v.x = game.v.z = 0;
  game.spawn = 0;
  ball.position.set(start.x, BALL_R, start.z);
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
    f.y = Math.max(f.y + f.vy * dt, -TRAY_DEPTH + BALL_R);
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
    let speed = Math.hypot(v.x, v.z) * damp;
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
  const visual = input.sensor ? 0.25 : 0.6;
  pivot.rotation.x = input.tilt.z * visual;
  pivot.rotation.z = -input.tilt.x * visual;

  updateHud();
  renderer.render(scene, camera);
});

buildLevel(game.level);
