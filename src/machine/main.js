import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildLayout } from './layout.js';
import { Machine } from './sim.js';
import { planSupports } from './supports.js';
import { buildMeshes, updateMeshes } from './scene.js';
import { MachineSound } from './sound.js';

const MARBLES = 12;
const $ = (id) => document.getElementById(id);

// ---- Renderer & scene ----
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e3da);
scene.fog = new THREE.Fog(0xe9e3da, 3, 9);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

scene.add(new THREE.HemisphereLight(0xfff8ef, 0xc9b9a3, 0.9));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
sun.position.set(-0.8, 1.6, 1.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.5, far: 4 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.002;
scene.add(sun);

const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0xe9e3da, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.028;
floor.receiveShadow = true;
scene.add(floor);

// ---- Camera & touch controls: one finger orbits, two pinch to zoom and pan ----
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20);
camera.position.set(0.62, 0.62, 1.05);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.28, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.12;
controls.maxDistance = 2.4;
controls.maxPolarAngle = Math.PI * 0.49;
controls.zoomToCursor = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.5;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
// Let it slowly turn by itself until someone takes over; resume after a while.
let idleTimer = 0;
controls.addEventListener('start', () => {
  controls.autoRotate = false;
  clearTimeout(idleTimer);
  $('hint').classList.add('gone');
});
controls.addEventListener('end', () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { controls.autoRotate = true; }, 20000);
});

// Fit the whole machine (a sphere this big round the target) in view.
const FIT_RADIUS = 0.52;
function fitDistance() {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  return FIT_RADIUS / Math.sin(Math.min(vFov, hFov) / 2);
}
// ?view=x,y,z,tx,ty,tz starts the camera at a given spot looking at a given point.
const view = new URLSearchParams(location.search).get('view')?.split(',').map(Number);
if (view?.length === 6 && view.every(Number.isFinite)) {
  camera.position.set(view[0], view[1], view[2]);
  controls.target.set(view[3], view[4], view[5]);
  controls.autoRotate = false;
}
let fitted = !!(view?.length === 6);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 45 : 35;
  camera.updateProjectionMatrix();
  if (!fitted) {
    const dir = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, fitDistance());
    fitted = true;
  }
}
addEventListener('resize', resize);
resize();

// ---- Wood textures (CC0, Poly Haven; see tools/fetch_textures.py) ----
async function loadMaps() {
  const loader = new THREE.TextureLoader();
  const load = async (file, srgb) => {
    const t = await loader.loadAsync(`${import.meta.env.BASE_URL}textures/${file}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const set = async (name) => {
    const [albedo, normal, rough] = await Promise.all([load(`${name}_albedo`, true), load(`${name}_normal`), load(`${name}_rough`)]);
    return { albedo, normal, rough };
  };
  const [board, wood, walnut, teak] = await Promise.all(['board', 'wood', 'walnut', 'teak'].map(set));
  return { board, wood, walnut, teak };
}

// ---- Slow motion: real time, half or quarter speed ----
const SPEEDS = [[1, '1×'], [0.5, '½×'], [0.25, '¼×']];
let speed = 1;   // index into SPEEDS; starts at half speed so marbles are easy to follow
const speedBtn = $('btn-speed');
const showSpeed = () => {
  speedBtn.textContent = SPEEDS[speed][1];
  speedBtn.title = SPEEDS[speed][0] === 1 ? 'Real speed' : `Slow motion (${SPEEDS[speed][1]})`;
};
speedBtn.addEventListener('click', () => {
  speed = (speed + 1) % SPEEDS.length;
  showSpeed();
});
showSpeed();

// ---- Sound: wooden knocks, glass clacks, the rumble of rolling ----
const sound = new MachineSound();
const soundBtn = $('btn-sound');
soundBtn.addEventListener('click', () => {
  sound.toggle();
  soundBtn.classList.toggle('on', sound.on);
  soundBtn.setAttribute('aria-pressed', String(sound.on));
});

async function start() {
  const layout = buildLayout();
  const supports = planSupports(layout);
  const machine = new Machine(layout, MARBLES);
  const maps = await loadMaps();
  const meshes = buildMeshes(layout, supports, maps, renderer.capabilities.getMaxAnisotropy());
  scene.add(meshes.group);
  for (const m of meshes.marbleMeshes.slice(0, MARBLES)) scene.add(m);
  $('loading').classList.add('gone');

  const clock = new THREE.Clock();
  // Frame rate readout, refreshed twice a second.
  const fpsEl = $('fps');
  let frames = 0, since = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    frames++;
    if (now - since >= 500) {
      const fps = (frames * 1000) / (now - since);
      fpsEl.textContent = `${fps.toFixed(0)} fps · ${(1000 / fps).toFixed(1)} ms`;
      frames = 0;
      since = now;
    }
    const dt = Math.min(clock.getDelta(), 0.05);
    const scaled = dt * SPEEDS[speed][0];
    machine.update(scaled);
    updateMeshes(machine, meshes, scaled);
    sound.play(machine, camera);
    controls.update(dt);
    renderer.render(scene, camera);
  });
  // Warm the machine up first so marbles are already spread around it.
  for (let i = 0; i < 600; i++) machine.update(1 / 60);
  machine.events.length = 0;
}

start().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Something went wrong building the machine.';
});
