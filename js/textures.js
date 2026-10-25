import * as THREE from 'three';
import { mulberry32 } from './maze.js';

const fract = (x) => x - Math.floor(x);
const hash2 = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);

/** Procedural wood with grain running along the canvas x axis. */
export function paintWood(ctx, w, h, { light, dark, seed = 1, scale = 1 }) {
  const rng = mulberry32(seed);
  const ph = Array.from({ length: 6 }, () => rng() * Math.PI * 2);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / scale, v = y / scale;
      const warp =
        Math.sin(u * 0.004 + ph[5]) * 20 +
        Math.sin(u * 0.011 + ph[0]) * 9 +
        Math.sin(u * 0.037 + ph[1]) * 2.5;
      const vv = v + warp;
      let ring = 0.5 + 0.5 * Math.sin(vv * 0.21 + Math.sin(vv * 0.03 + ph[2]) * 2.2);
      ring = ring ** 4;
      const broad = 0.5 + 0.5 * Math.sin(vv * 0.035 + ph[3]);
      const fiber = hash2(Math.floor(u / 9 + ph[4]), Math.floor(vv * 1.3));
      const t = Math.min(1, ring * 0.45 + broad * 0.3 + fiber * 0.12);
      const i = (y * w + x) * 4;
      d[i] = light[0] + (dark[0] - light[0]) * t;
      d[i + 1] = light[1] + (dark[1] - light[1]) * t;
      d[i + 2] = light[2] + (dark[2] - light[2]) * t;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function finish(canvas, anisotropy) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

export function makeWoodTexture(w, h, opts, anisotropy = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  paintWood(canvas.getContext('2d'), w, h, opts);
  const tex = finish(canvas, anisotropy);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * The playing surface: pale wood plus the printed guide line, hole numbers
 * and START / FINISH marks. Canvas x/y map to world x/z.
 */
export function makeBoardTexture({ W, H, ppu, cell, path, holes, goal, startLabel, goalLabel, holeR }, anisotropy = 1) {
  const cw = Math.round(W * ppu), ch = Math.round(H * ppu);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  paintWood(ctx, cw, ch, { light: [238, 214, 170], dark: [218, 186, 136], seed: 11, scale: ppu * 0.03 });

  const P = (pt) => [(pt.x + W / 2) * ppu, (pt.z + H / 2) * ppu];
  const ink = 'rgba(24, 18, 12, 0.92)';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Guide line: straight runs with rounded corners, ending short of the
  // finish hole in an arrow.
  const pts = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) pts.push(b);
  }
  const last = path[path.length - 1], prev = pts[pts.length - 1];
  const dl = Math.hypot(last.x - prev.x, last.z - prev.z);
  const ux = (last.x - prev.x) / dl, uz = (last.z - prev.z) / dl;
  const tip = { x: last.x - ux * (holeR + 0.12), z: last.z - uz * (holeR + 0.12) };
  pts.push(tip);

  ctx.lineWidth = 0.07 * ppu;
  ctx.beginPath();
  ctx.moveTo(...P(pts[0]));
  for (let i = 1; i < pts.length - 1; i++) ctx.arcTo(...P(pts[i]), ...P(pts[i + 1]), cell * 0.5 * ppu);
  ctx.lineTo(...P(pts[pts.length - 1]));
  ctx.stroke();

  // Arrow head into the finish.
  const [tx, ty] = P(tip), a = 0.22 * ppu, b = 0.12 * ppu;
  ctx.beginPath();
  ctx.moveTo(tx + ux * a * 0.4, ty + uz * a * 0.4);
  ctx.lineTo(tx - ux * a + uz * b, ty - uz * a - ux * b);
  ctx.lineTo(tx - ux * a - uz * b, ty - uz * a + ux * b);
  ctx.closePath();
  ctx.fill();

  // T-bar where the line starts.
  const s0 = path[0], s1 = path[1];
  const sl = Math.hypot(s1.x - s0.x, s1.z - s0.z);
  const px = -(s1.z - s0.z) / sl, pz = (s1.x - s0.x) / sl;
  ctx.beginPath();
  ctx.moveTo(...P({ x: s0.x + px * 0.28, z: s0.z + pz * 0.28 }));
  ctx.lineTo(...P({ x: s0.x - px * 0.28, z: s0.z - pz * 0.28 }));
  ctx.stroke();

  // Faint printed rims make the holes read crisply against pale wood.
  ctx.lineWidth = 0.025 * ppu;
  ctx.strokeStyle = 'rgba(90, 60, 30, 0.35)';
  for (const h of [...holes, goal]) {
    const [x, y] = P(h);
    ctx.beginPath();
    ctx.arc(x, y, (holeR + 0.02) * ppu, 0, Math.PI * 2);
    ctx.stroke();
  }

  const font = (s) => `${Math.round(s * ppu)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(0.3);
  for (const h of holes) {
    if (!h.num) continue;
    ctx.fillText(String(h.num), ...P(h.label));
  }
  ctx.font = `bold ${font(0.26)}`;
  ctx.fillText('START', ...P(startLabel));
  ctx.fillText('FINISH', ...P(goalLabel));

  return finish(canvas, anisotropy);
}
