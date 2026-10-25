import * as THREE from 'three';
import { R, RAIL_R, RIDE } from './physics.js';

// Where the wooden supports go: posts from the base up to the ties under the
// rails, each placed where it stays clear of every other track, the marbles'
// flight paths, the funnel and the lift. Pure data, so the checker can
// verify it too.

export const POST_R = 0.004;
export const TIE_DROP = RIDE + RAIL_R + 0.002;   // marble centre to the underside of a tie
const SPACING = 0.15;
const CLEAR = R + RAIL_R + POST_R + 0.003;       // post to any marble path

/** Points every few millimetres along everything a marble's centre passes through. */
function marblePaths(layout) {
  const pts = [];
  for (const t of layout.tracks) {
    for (let s = 0; s <= t.path.length; s += 0.004) pts.push({ p: t.path.at(s), t, s });
  }
  for (const arc of layout.flights || []) for (const p of arc) pts.push({ p, t: null, s: 0 });
  return pts;
}

/** Closest distance from point p to the segment a-b. */
function segDist(p, a, b) {
  const ab = tmp1.subVectors(b, a), ap = tmp2.subVectors(p, a);
  const t = Math.max(0, Math.min(1, ap.dot(ab) / (ab.lengthSq() || 1)));
  return ap.addScaledVector(ab, -t).length();
}
const tmp1 = new THREE.Vector3(), tmp2 = new THREE.Vector3();

export function planSupports(layout) {
  const paths = marblePaths(layout);
  const { lift, spiral, funnels, helixPosts = [], rings = [] } = layout;
  const onPosts = new Set([...helixPosts, ...rings].flatMap((h) => h.tracks));
  const posts = [];   // { base, top, arm?: { from, to } }
  const arms = [];    // spiral arms: { from, to }
  const hangers = []; // from the overhead beam down to the top run: { from, to }

  const blocked = (a, b, own, s) => {
    for (const q of paths) {
      if (q.t === own && Math.abs(q.s - s) < 0.04) continue;
      if (segDist(q.p, a, b) < CLEAR) return true;
    }
    for (const f of funnels) {
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      if (hi < f.surface(f.hole) - 0.05 || lo > f.rimY + 0.01) continue;
      if (Math.hypot(a.x - f.cx, a.z - f.cz) < f.radius + 0.012 || Math.hypot(b.x - f.cx, b.z - f.cz) < f.radius + 0.012) return true;
    }
    // The lift tower and the spiral's central post.
    const box = (x, z) => Math.abs(x - lift.x) < 0.06 && Math.abs(z - lift.z) < 0.05;
    if (box(a.x, a.z) || box(b.x, b.z)) return true;
    for (const h of helixPosts) {
      if (Math.hypot(a.x - h.x, a.z - h.z) < 0.03 || Math.hypot(b.x - h.x, b.z - h.z) < 0.03) return true;
    }
    return false;
  };

  const frame = { t: new THREE.Vector3(), l: new THREE.Vector3(), u: new THREE.Vector3() };

  // The top run hangs from a beam between the lift tower and the spiral's post.
  const topRun = layout.lift.to;
  const beamY = topRun.path.at(0).y + 0.045;
  const beam = { from: new THREE.Vector3(lift.x, beamY, lift.z), to: new THREE.Vector3(spiral.x, beamY, lift.z) };
  for (let s = 0.07; s < topRun.path.length - 0.02; s += 0.1) {
    const p = topRun.path.at(s);
    topRun.path.frame(s, frame);
    const under = p.clone().addScaledVector(frame.u, -TIE_DROP);
    // Hang beside the marble, outside the rails, down to the tie's end.
    const end = under.clone().addScaledVector(frame.l, -(0.014));
    hangers.push({ from: new THREE.Vector3(end.x, beamY, end.z), to: end });
  }

  // The switchback stack sits on two ladder posts with an arm to each ramp end.
  const { stack } = layout;
  const ladders = [];
  for (const x of [stack.left - 0.03, stack.right + 0.03]) {
    for (const dz of [-0.024, 0.024]) {
      const base = new THREE.Vector3(x, 0, stack.z + dz);
      const top = new THREE.Vector3(x, stack.ramps[0].path.at(stack.ramps[0].path.length).y - TIE_DROP + 0.004, stack.z + dz);
      if (!blocked(base, top, null, 0)) { ladders.push({ base, top, x }); break; }
    }
  }
  const onLadder = new Set();
  for (const ramp of stack.ramps) {
    for (const s of [0.012, ramp.path.length - 0.012]) {
      const p = ramp.path.at(s);
      const ladder = ladders.find((l) => Math.abs(l.x - p.x) < 0.06);
      if (!ladder) continue;
      ramp.path.frame(s, frame);
      const under = p.clone().addScaledVector(frame.u, -TIE_DROP);
      const from = new THREE.Vector3(ladder.x, under.y, ladder.base.z);
      if (blocked(from, under, ramp, s)) continue;
      posts.push({ base: null, top: null, arm: { from, to: under }, track: ramp, s });
      onLadder.add(`${ramp.name}:${s > 0.1 ? 'end' : 'start'}`);
    }
  }
  for (const l of ladders) posts.push({ base: l.base, top: l.top, arm: null, track: null, s: 0 });

  // The little drop stack under the big funnel hangs between two ladder posts,
  // one off its north end and one beside its south end, clear of the bowl above.
  const drops = layout.drops || [];
  if (drops.length) {
    const zs = drops.flatMap((d) => [d.path.at(0).z, d.path.at(d.path.length).z]);
    const x = drops[0].path.at(0).x;
    const topY = Math.max(...drops.map((d) => Math.max(d.path.at(0).y, d.path.at(d.path.length).y))) - TIE_DROP + 0.004;
    const dropPosts = [
      { x, z: Math.min(...zs) - 0.022, north: true },
      { x: x + 0.028, z: Math.max(...zs) - 0.012, north: false },
    ];
    for (const lp of dropPosts) posts.push({ base: new THREE.Vector3(lp.x, 0, lp.z), top: new THREE.Vector3(lp.x, topY, lp.z), arm: null, track: null, s: 0 });
    for (const d of drops) {
      for (const s of [0.012, d.path.length - 0.012]) {
        const p = d.path.at(s);
        d.path.frame(s, frame);
        const under = p.clone().addScaledVector(frame.u, -TIE_DROP);
        const north = p.z < (Math.min(...zs) + Math.max(...zs)) / 2;
        const lp = dropPosts.find((q) => q.north === north);
        posts.push({ base: null, top: null, arm: { from: new THREE.Vector3(lp.x, under.y, lp.z), to: under }, track: d, s });
      }
    }
  }

  for (const track of layout.tracks) {
    if (onPosts.has(track) || track === topRun || drops.includes(track)) continue;
    const isRamp = stack.ramps.includes(track) && track !== stack.ramps[0];
    if (isRamp && onLadder.has(`${track.name}:start`) && onLadder.has(`${track.name}:end`)) continue;
    const len = track.path.length;
    const n = Math.max(1, Math.round(len / SPACING));
    for (let i = 0; i <= n; i++) {
      const s = Math.min(len - 0.01, Math.max(0.01, (i / n) * len));
      const p = track.path.at(s);
      track.path.frame(s, frame);
      const under = p.clone().addScaledVector(frame.u, -TIE_DROP);
      // Straight down if it can, otherwise beside the track with an arm across.
      const flat = frame.l.clone().setY(0).normalize();
      for (const off of [0, 0.03, -0.03, 0.05, -0.05]) {
        const top = under.clone().addScaledVector(flat, off);
        top.y = under.y - (off ? 0.006 : 0);
        const base = new THREE.Vector3(top.x, 0, top.z);
        if (blocked(base, top, track, s)) continue;
        if (off && blocked(top, under, track, s)) continue;
        posts.push({ base, top, arm: off ? { from: top, to: under } : null, track, s });
        break;
      }
    }
  }

  // Helices wound round a central post: spokes from the post to the coil at
  // three fixed angles, so they line up turn after turn.
  for (const h of helixPosts) {
    const centre = new THREE.Vector3(h.x, 0, h.z);
    const spokes = h.spokes || [Math.PI / 6, (5 * Math.PI) / 6, (3 * Math.PI) / 2];
    for (const coil of h.tracks) {
      let last = -1;
      for (let s = 0.02; s < coil.path.length - 0.02; s += 0.003) {
        const p = coil.path.at(s);
        const r = Math.hypot(p.x - h.x, p.z - h.z);
        if (Math.abs(r - h.coilRadius) > 0.006) continue;
        const ang = Math.atan2(p.z - h.z, p.x - h.x);
        if (!spokes.some((a) => Math.abs(Math.atan2(Math.sin(ang - a), Math.cos(ang - a))) < 0.03)) continue;
        if (last >= 0 && s - last < 0.05) continue;
        last = s;
        coil.path.frame(s, frame);
        const under = p.clone().addScaledVector(frame.u, -TIE_DROP);
        arms.push({ from: centre.clone().setY(under.y), to: under });
      }
    }
  }
  // Helices with a ring of posts round the outside: a short arm in to each
  // turn where it passes a post.
  for (const ring of rings) {
    for (const a of ring.angles) {
      const px = ring.x + Math.cos(a) * ring.postRadius, pz = ring.z + Math.sin(a) * ring.postRadius;
      let top = 0;
      const ringArms = [];
      for (const coil of ring.tracks) {
        for (let s = 0.02; s < coil.path.length - 0.02; s += 0.003) {
          const p = coil.path.at(s);
          const r = Math.hypot(p.x - ring.x, p.z - ring.z);
          if (Math.abs(r - ring.radius) > 0.006) continue;
          let off = Math.atan2(p.z - ring.z, p.x - ring.x) - a;
          off = Math.atan2(Math.sin(off), Math.cos(off));
          if (Math.abs(off) > 0.02) continue;
          if (ringArms.length && Math.abs(ringArms[ringArms.length - 1].s - s) < 0.05) continue;
          coil.path.frame(s, frame);
          const under = p.clone().addScaledVector(frame.u, -TIE_DROP);
          ringArms.push({ s, from: new THREE.Vector3(px, under.y, pz), to: under });
          top = Math.max(top, under.y);
        }
      }
      if (!ringArms.length) continue;
      const base = new THREE.Vector3(px, 0, pz), postTop = new THREE.Vector3(px, top + 0.012, pz);
      if (blocked(base, postTop, ring.tracks[0], -1)) continue;
      posts.push({ base, top: postTop, arm: null, track: null, s: 0 });
      for (const arm of ringArms) arms.push({ from: arm.from, to: arm.to });
    }
  }
  return { posts, arms, hangers, beam, beamY };
}
