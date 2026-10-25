// Draws the marble machine's tracks from above and from the front as an SVG,
// for checking a layout by eye.
//
//     node tools/plot_machine.mjs out.svg
import fs from 'fs';
import { buildLayout } from '../src/machine/layout.js';

const layout = buildLayout();
const S = 780;                 // pixels per metre
const W = 1.25 * S, D = 0.85 * S, H = 1.0 * S;
const colours = ['#c0392b', '#2471a3', '#229954', '#d68910', '#7d3c98', '#17a589', '#a04000', '#2e4053', '#b03a2e', '#1f618d', '#239b56', '#b9770e'];

const top = (p) => [W / 2 + p.x * S, D / 2 + p.z * S];
const front = (p) => [W / 2 + p.x * S, D + 30 + H - p.y * S];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${D + H + 60}" font-family="sans-serif" font-size="11">`;
svg += `<rect width="100%" height="100%" fill="#fbf7f0"/>`;
svg += `<rect x="${W / 2 - 0.6 * S}" y="${D / 2 - 0.4 * S}" width="${1.2 * S}" height="${0.8 * S}" fill="none" stroke="#bbb"/>`;
svg += `<line x1="0" y1="${D + 30 + H}" x2="${W}" y2="${D + 30 + H}" stroke="#bbb"/>`;
for (let y = 0.1; y < 1; y += 0.1) svg += `<text x="4" y="${D + 30 + H - y * S}" fill="#999">${y.toFixed(1)}</text>`;
layout.tracks.forEach((t, i) => {
  const c = colours[i % colours.length];
  for (const view of [top, front]) {
    const pts = [];
    for (let s = 0; s <= t.path.length; s += 0.005) pts.push(view(t.path.at(s)).map((v) => v.toFixed(1)).join(','));
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="2" opacity="0.85"/>`;
    const [x, y] = view(t.path.at(t.path.length / 2));
    svg += `<text x="${x + 4}" y="${y - 4}" fill="${c}">${t.name}</text>`;
  }
});
for (const f of layout.funnels) {
  const [x, y] = top({ x: f.cx, z: f.cz });
  svg += `<circle cx="${x}" cy="${y}" r="${f.radius * S}" fill="none" stroke="#6e4b2a" stroke-width="2"/>`;
  const [fx, fy] = front({ x: f.cx, y: f.rimY });
  svg += `<line x1="${fx - f.radius * S}" y1="${fy}" x2="${fx + f.radius * S}" y2="${fy}" stroke="#6e4b2a" stroke-width="3"/>`;
}
for (const arc of layout.flights) {
  for (const view of [top, front]) {
    svg += `<polyline points="${arc.map((p) => view(p).join(',')).join(' ')}" fill="none" stroke="#888" stroke-dasharray="3,3"/>`;
  }
}
const L = layout.lift;
svg += `<rect x="${top({ x: L.x - 0.03, z: L.z - 0.03 })[0]}" y="${top({ x: 0, z: L.z - 0.03 })[1]}" width="${0.06 * S}" height="${0.06 * S}" fill="#6e4b2a" opacity="0.4"/>`;
svg += `<line x1="${front({ x: L.ballX, y: L.pickY })[0]}" y1="${front({ x: 0, y: L.pickY })[1]}" x2="${front({ x: L.ballX, y: L.releaseY })[0]}" y2="${front({ x: 0, y: L.releaseY })[1]}" stroke="#6e4b2a" stroke-width="4"/>`;
svg += `<text x="10" y="16">top view</text><text x="10" y="${D + 24}">front view</text></svg>`;
fs.writeFileSync(process.argv[2] || 'machine.svg', svg);
