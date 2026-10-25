// Headless checks for the marble machine layout and physics.
//
//     node tools/check_machine.mjs [seconds]
//
// Builds the layout (which test-rolls a marble through it), checks that no
// two tracks pass too close, then runs the full simulation with every marble
// for a while and reports laps, losses and stuck marbles.
import * as THREE from 'three';
import { buildLayout } from '../src/machine/layout.js';
import { R, RAIL_R, RIDE } from '../src/machine/physics.js';
import { Machine } from '../src/machine/sim.js';

const layout = buildLayout();
const { report } = layout;
const f = layout.funnels[0];
console.log(`${report.switches} flip-flops; jump launch ${report.jumpLaunch.v.length().toFixed(2)} m/s; funnel at (${f.cx.toFixed(3)}, ${f.rimY.toFixed(3)}, ${f.cz.toFixed(3)}), orbit ${report.orbit.toFixed(1)} s`);
console.log('exit speeds', JSON.stringify(Object.fromEntries(Object.entries(report.speeds).map(([k, v]) => [k, +v.toFixed(2)]))));
for (const t of layout.tracks) {
  const a = t.path.at(0), b = t.path.at(t.path.length);
  const maxBank = Math.max(...t.path.bank.map(Math.abs)) * 180 / Math.PI;
  console.log(`${t.name.padEnd(14)} ${t.path.length.toFixed(3)} m  (${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${a.z.toFixed(3)}) -> (${b.x.toFixed(3)}, ${b.y.toFixed(3)}, ${b.z.toFixed(3)})  bank ≤ ${maxBank.toFixed(0)}°`);
}

// Clearance between tracks: marble-centre paths of different tracks must stay
// a marble plus rails apart, except near where they join.
const need = 2 * R + 2 * RAIL_R + RIDE;
const joins = new Map();
const near = (t, s) => (joins.get(t) || []).some((js) => Math.abs(js - s) < 0.15);
for (const t of layout.tracks) {
  if (t.end.to) {
    joins.set(t, [...(joins.get(t) || []), t.path.length]);
    joins.set(t.end.to, [...(joins.get(t.end.to) || []), 0]);
  }
}
for (const sw of layout.switches) {
  for (const b of sw.branches) joins.set(b, [...(joins.get(b) || []), 0]);
}
for (const t of layout.tracks) {
  if (t.end.type === 'switch') joins.set(t, [...(joins.get(t) || []), t.path.length]);
}
const pa = new THREE.Vector3(), pb = new THREE.Vector3();
let worst = Infinity, problems = 0;
const pairs = new Map();   // "A / B" -> { n, min, at }
const tracks = layout.tracks;
for (let i = 0; i < tracks.length; i++) {
  for (let j = i; j < tracks.length; j++) {
    const A = tracks[i], B = tracks[j];
    for (let sa = 0; sa < A.path.length; sa += 0.004) {
      if (near(A, sa)) continue;
      A.path.at(sa, pa);
      for (let sb = i === j ? sa + 0.08 : 0; sb < B.path.length; sb += 0.004) {
        if (near(B, sb)) continue;
        // A track can't be too close to itself except far along (spiral turns are checked).
        const d = pa.distanceTo(B.path.at(sb, pb));
        worst = Math.min(worst, d);
        if (d < need) {
          problems++;
          const key = `${A.name} / ${B.name}`;
          const e = pairs.get(key) || { n: 0, min: Infinity };
          e.n++;
          if (d < e.min) Object.assign(e, { min: d, at: `@${sa.toFixed(2)} / @${sb.toFixed(2)}`, p: pa.clone() });
          pairs.set(key, e);
        }
      }
    }
  }
}
for (const [key, e] of pairs) {
  console.log(`  too close: ${key} ${e.at}: ${(e.min * 1000).toFixed(1)} mm near (${e.p.x.toFixed(2)}, ${e.p.y.toFixed(2)}, ${e.p.z.toFixed(2)}) [${e.n}]`);
}
console.log(`closest approach between tracks ${(worst * 1000).toFixed(1)} mm (need ${(need * 1000).toFixed(1)}), ${problems} problems`);

// Full simulation.
const seconds = +(process.argv[2] || 300);
const machine = new Machine(layout, 12);
const dt = 1 / 60;
// Track the longest any marble goes between trips up the lift.
const lastLap = new Map(machine.marbles.map((m) => [m, 0]));
let longest = 0;
for (let t = 0; t < seconds; t += dt) {
  machine.update(dt);
  for (const m of machine.marbles) {
    if (m.mode === 'lift') lastLap.set(m, t);
    longest = Math.max(longest, t - lastLap.get(m));
  }
}
const s = machine.stats;
console.log(`${seconds}s with ${machine.marbles.length} marbles: ${s.laps} laps (${(s.laps / seconds * 60).toFixed(1)}/min), switch ${s.branch.join('/')}, lost ${s.lost}, longest between laps ${longest.toFixed(1)} s, states now ${JSON.stringify(machine.census())}`);
for (const l of s.losses || []) console.log(`  lost a marble flying from ${l.from} at t=${l.t.toFixed(1)}: (${l.at.x.toFixed(3)}, ${l.at.y.toFixed(3)}, ${l.at.z.toFixed(3)})`);
if (longest > 60) process.exitCode = 1;
if (s.lost || problems) process.exitCode = 1;

// Supports: how many, and any track pieces left without one for long.
const { planSupports } = await import('../src/machine/supports.js');
const sup = planSupports(layout);
const gaps = [];
for (const t of layout.tracks) {
  if ([...layout.helixPosts, ...layout.rings].some((h) => h.tracks.includes(t))) continue;   // on arms from posts
  if (t === layout.lift.to) continue;   // hangs from the beam
  const at = sup.posts.filter((p) => p.track === t).map((p) => p.s).sort((a, b) => a - b);
  const edges = [0, ...at, t.path.length];
  const worstGap = Math.max(...edges.slice(1).map((s, i) => s - edges[i]));
  if (worstGap > 0.25) gaps.push(`${t.name} ${worstGap.toFixed(2)} m`);
}
console.log(`supports: ${sup.posts.length} posts, ${sup.arms.length} spiral arms, ${sup.hangers.length} hangers${gaps.length ? '; long unsupported spans: ' + gaps.join(', ') : ''}`);
