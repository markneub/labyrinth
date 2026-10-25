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
 * The playing surface: wood plus the printed guide line, hole rims, numbers
 * and START / FINISH marks. Canvas x/y map to world x/z.
 */
export function makeBoardTexture({ W, H, ppu, path, holes, goal, start, holeR }, anisotropy = 1) {
  const cw = Math.round(W * ppu), ch = Math.round(H * ppu);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  paintWood(ctx, cw, ch, { light: [230, 196, 146], dark: [186, 136, 86], seed: 11, scale: ppu * 0.035 });

  const P = (pt) => [(pt.x + W / 2) * ppu, (pt.z + H / 2) * ppu];
  const ink = 'rgba(30, 19, 10, 0.88)';

  // Varnish darkening toward the rim.
  const g = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.3, cw / 2, ch / 2, Math.hypot(cw, ch) * 0.6);
  g.addColorStop(0, 'rgba(80, 40, 10, 0)');
  g.addColorStop(1, 'rgba(80, 40, 10, 0.25)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.07 * ppu;
  ctx.beginPath();
  path.forEach((pt, i) => {
    const [x, y] = P(pt);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();

  ctx.lineWidth = 0.05 * ppu;
  for (const h of holes) {
    const [x, y] = P(h);
    ctx.beginPath();
    ctx.arc(x, y, (holeR + 0.05) * ppu, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(0.3 * ppu)}px Georgia, 'Times New Roman', serif`;
  for (const h of holes) {
    if (!h.num) continue;
    const [x, y] = P(h.label);
    ctx.fillText(String(h.num), x, y);
  }

  ctx.font = `bold ${Math.round(0.26 * ppu)}px Georgia, 'Times New Roman', serif`;
  const [sx, sy] = P(start);
  ctx.beginPath();
  ctx.arc(sx, sy, 0.42 * ppu, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillText('START', sx, sy - 0.78 * ppu);

  const [gx, gy] = P(goal);
  ctx.fillText('FINISH', gx, gy + 0.8 * ppu);

  return finish(canvas, anisotropy);
}
