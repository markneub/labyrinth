import * as THREE from 'three';
import { Path, Turtle } from './path.js';
import { G, R, BOUNCE, Funnel, trackAccel, funnelStep, flyStep } from './physics.js';

// The machine, laid out in metres on a base whose top is y = 0. x runs left
// to right, z towards the viewer.
//
// Marbles ride a paddle chain up the back-left tower, roll along the top
// run to the spiral tower on the right, wind down it and reach a flip-flop
// switch that sends them alternately
//   - down a steep ramp and off a kicker into a funnel bowl, or
//   - down a stack of switchback ramps, dropping from each onto the next,
// before both ways merge into the return run back to the chain.
//
// Pieces whose position depends on where a marble really goes (a jump's
// funnel, a drop's catching ramp) are placed by test-rolling a marble
// through the machine as it is built, and curves are banked for the speed
// the marble actually has there.

export class Track {
  constructor(name, path, { backstop = false } = {}) {
    this.name = name;
    this.path = path;
    this.backstop = backstop;   // an end block at s = 0
    this.end = { type: 'stop' }; // what happens at the far end: next | switch | fly | stop
    this.catch = null;          // [s0, s1]: where a flying marble can land on it
    this.style = 'routed';      // routed: a groove cut in a maple board; rails: two dowels on ties
  }
}

export class Switch {
  constructor(at, dir, branches) {
    this.at = at;            // the fork point
    this.dir = dir;          // incoming direction
    this.branches = branches;
    this.state = 0;          // which branch the next marble takes
  }
}

const DT = 1 / 4000;

/**
 * Roll a test marble along `track` from s0 at speed v0 until it leaves the
 * far end. Returns the exit speed and the fastest speed seen at each
 * sample (for banking). Throws if it would come to rest on the way.
 */
function roll(track, v0, s0 = 0) {
  const path = track.path;
  const speed = new Float32Array(path.count);
  let s = s0, v = v0, t = 0, still = 0;
  while (s < path.length) {
    v += trackAccel(path, s, v) * DT;
    s += v * DT;
    t += DT;
    if (s < 0) {
      if (!track.backstop) throw new Error(`${track.name}: marble rolled back off the start`);
      s = 0;
      v = -v * BOUNCE;
    }
    const i = Math.round(path.index(s));
    speed[i] = Math.max(speed[i], Math.abs(v));
    still = Math.abs(v) < 0.01 ? still + DT : 0;
    if (still > 0.5 || t > 30) throw new Error(`${track.name}: marble stalls at s=${s.toFixed(3)}`);
  }
  holdCheck(track, speed);
  return { v, speed, t };
}

/**
 * The rails can push a marble but never pull it: wherever the path curves
 * (over a hill crest, round the top of a loop) the speed must be such that
 * the rails still press up against it. Throws where they wouldn't.
 */
function holdCheck(track, speed) {
  const { path } = track;
  const f = { t: new THREE.Vector3(), l: new THREE.Vector3(), u: new THREE.Vector3() };
  const t0 = new THREE.Vector3(), t1 = new THREE.Vector3();
  // (skipping the last few millimetres at each end, where a track is pinned
  // to the exact point and heading of the piece it joins)
  for (let i = 8; i < path.count - 8; i++) {
    const v = speed[i];
    if (!v) continue;
    const s = i * path.step;
    path.frame(s, f);
    path.tangent(s - 2 * path.step, t0);
    path.tangent(s + 2 * path.step, t1);
    const bend = t1.sub(t0).divideScalar(4 * path.step);   // dT/ds, towards the centre of curvature
    const press = v * v * bend.dot(f.u) + G * f.u.y;       // what the rails must supply, along u
    if (press < 0) {
      const msg = `${track.name}: marble would leave the rails at s=${s.toFixed(3)} (${press.toFixed(2)} m/s²)`;
      if (globalThis.LAYOUT_WARN) { console.warn(msg); return; }
      throw new Error(msg);
    }
  }
}

/** Bank every curve for the speed found by `roll`, so the marble sits square on the rails. */
function bankFor(track, speed) {
  const { path } = track;
  const raw = new Float32Array(path.count);
  let last = 0;
  for (let i = 0; i < path.count; i++) {
    const v = speed[i] || last;
    last = v;
    raw[i] = Math.atan((v * v * path.curv[i]) / G);
  }
  // Ease the bank in and out over a few centimetres, but never less than a
  // curve needs: hold each curve's peak a little past its ends (being over-
  // banked on a straight is harmless), then smooth.
  const w = 20;
  const held = new Float32Array(path.count);
  for (let i = 0; i < path.count; i++) {
    let best = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(path.count - 1, i + w); j++) if (Math.abs(raw[j]) > Math.abs(best)) best = raw[j];
    held[i] = best;
  }
  for (let i = 0; i < path.count; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(path.count - 1, i + w); j++) { sum += held[j]; n++; }
    path.bank[i] = Math.max(-1.25, Math.min(1.25, sum / n));
  }
}

/** Launch state at the end of a track. */
function launch(track, v) {
  const p = track.path.at(track.path.length);
  const vel = track.path.tangent(track.path.length).multiplyScalar(v);
  if (track.end.wall) bounceOffWall(vel);
  return { p, v: vel };
}

/** An end block at a ramp's end: the marble bounces back off it and drops through the gap below. */
export function bounceOffWall(vel) {
  vel.x *= -BOUNCE;
  vel.z *= -BOUNCE;
  return vel;
}

/** Fly from state until `done(p, v)` returns true; returns the final state and the arc flown. */
function flyUntil({ p, v }, done) {
  p = p.clone(); v = v.clone();
  const arc = [p.clone()];
  for (let t = 0, i = 0; t < 3; t += DT, i++) {
    flyStep(p, v, DT);
    if (i % 10 === 0) arc.push(p.clone());
    if (done(p, v)) { arc.push(p.clone()); return { p, v, arc }; }
  }
  throw new Error('flight never landed');
}

/** Roll around a funnel from where a marble lands until it drops through the hole. */
function orbit(funnel, { p, v }) {
  p = p.clone(); v = v.clone();
  p.y = funnel.restY(p.x, p.z);
  const n = funnel.normal(p.x, p.z);
  v.addScaledVector(n, -v.dot(n));
  for (let t = 0; t < 60; t += DT) {
    if (funnelStep(funnel, p, v, DT) === 'exit') return { p, v, t };
  }
  throw new Error('marble never left the funnel');
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * An S-bend: `forward` metres ahead while stepping `side` metres to the left
 * (negative: right), as two equal opposite arcs, falling `drop` metres.
 */
/** About how fast a marble dropped from a funnel's spout onto the ramp below sets off along it. */
const SPOUT_V = 0.12;

function sBend(t, forward, side, drop) {
  if (Math.abs(side) < 1e-3) return t.straight(forward, drop / forward);
  const a = 2 * Math.atan2(Math.abs(side) / 2, forward / 2);
  const r = forward / 2 / Math.sin(a);
  const sign = Math.sign(side) || 1;
  const grade = drop / (2 * r * a);   // per metre along the arcs
  t.turn(r, sign * a, grade);
  t.turn(r, -sign * a, grade);
  return t;
}

/** S-bend from where the turtle is to `target`, arriving with the same heading. */
function sBendTo(t, target) {
  const d = target.clone().sub(t.p);
  const forward = d.x * Math.cos(t.h) + d.z * Math.sin(t.h);
  const side = d.x * Math.sin(t.h) - d.z * Math.cos(t.h);   // to the left
  return sBend(t, forward, side, t.p.y - target.y);
}

/** Smallest distance between two lists of points. */
function gap(as, bs) {
  let d = Infinity;
  for (const a of as) for (const b of bs) d = Math.min(d, a.distanceTo(b));
  return d;
}

export function buildLayout() {
  const tracks = [];
  const funnels = [];
  const switches = [];
  const flights = [];   // arcs marbles fly through, kept clear of supports
  const chimes = [];    // tuned bars that marbles strike: { at, dir, note }
  const helixPosts = [];   // central posts with arms out to a helix
  const rings = [];        // posts round the outside of a helix, with arms in to it
  const add = (name, points, opts = {}) => {
    const t = new Track(name, new Path(points, opts), opts);
    tracks.push(t);
    return t;
  };
  /** A track laid by a turtle. */
  const lay = (name, turtle, opts = {}) => add(name, turtle.points(), {
    startDir: turtle.startDir, endDir: turtle.dir(), transport: turtle.looped, ...opts,
  });
  const turtle = (p, heading, grade = 0) => {
    const t = new Turtle(p, heading);
    t.grade = grade;
    t.startDir = t.dir(grade);
    return t;
  };
  const link = (a, b) => { a.end = { type: 'next', to: b }; };
  const fork = (into, a, b) => {
    const at = into.path.at(into.path.length);
    const sw = new Switch(at, into.path.tangent(into.path.length), [a, b]);
    switches.push(sw);
    into.end = { type: 'switch', switch: sw };
    return sw;
  };
  /** Roll a test marble through and bank for it; returns the exit speed. */
  const run = (track, v0, s0 = 0) => {
    const r = roll(track, v0, s0);
    bankFor(track, r.speed);
    return r.v;
  };
  const end = (track) => ({ p: track.path.at(track.path.length), dir: track.path.tangent(track.path.length) });
  const E = Math.PI, N = -Math.PI / 2, S = Math.PI / 2;   // headings: west (-x), north (-z), south (+z, towards the viewer)

  // ---- Paddle-chain lift, back left ----
  const lift = {
    x: -0.44, z: -0.24,
    yBottom: 0.12, yTop: 0.84,
    radius: 0.024,
    speed: 0.12,
    spacing: 0.07,
  };
  lift.ballX = lift.x + lift.radius + 0.011;
  lift.pickY = lift.yBottom + 0.04;
  lift.releaseY = lift.yTop - 0.006;

  // ---- Top run along the back to the first flip-flop ----
  const tower = { x: 0.36, outer: 0.115, inner: 0.065 };
  tower.z = lift.z + tower.outer;
  const top = lay('top run', turtle(V(lift.ballX, lift.releaseY, lift.z), 0, 0.06).ease(0.06, 0.03).straight(0.66 - 0.06 - 0.12 + (0.22 - 0.06), 0.03));
  // (ends at x ≈ 0.22)
  let v = run(top, 0.05);

  // ---- F1: twin concentric spirals round one tower ----
  const f1 = end(top);
  const outerT = turtle(f1.p, 0, 0.03).straight(tower.x - f1.p.x, 0.03);
  outerT.turn(tower.outer, -1.5 * 2 * Math.PI, 0.056);
  outerT.straight(0.09, 0.03);
  const outer = lay('outer spiral', outerT);
  rings.push({ x: tower.x, z: tower.z, radius: tower.outer, postRadius: tower.outer + 0.035, angles: [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75], tracks: [outer] });
  // The inner spiral steps in towards the tower, then winds tighter and faster.
  const innerT = turtle(f1.p, 0, 0.03);
  const dz = tower.outer - tower.inner, run1 = tower.x - f1.p.x;
  const half = Math.atan2(dz / 2, run1 / 2) * 2, rS = run1 / 2 / Math.sin(half);
  innerT.turn(rS, -half, 0.03);
  innerT.turn(rS, half, 0.03);
  innerT.turn(tower.inner, -2.5 * 2 * Math.PI, 0.098);
  innerT.straight(0.09, 0.03);
  const inner = lay('inner spiral', innerT);
  fork(top, outer, inner);
  helixPosts.push({ x: tower.x, z: tower.z, top: f1.p.y + 0.07, radius: 0.012, tracks: [inner], coilRadius: tower.inner });
  const vOuter = run(outer, v);
  const vInner = run(inner, v);

  // ---- Funnel bowls: placed where a jump lands, left through a spout ----
  /** A funnel where the marble flying off `track` (at speed v) comes down, partway in and across. */
  const catchIn = (track, v, { radius = 0.062, depth = 0.04, below = 0.045, landAt = 0.55, side = 1, ring = false } = {}) => {
    const off = launch(track, v);
    const rimY = off.p.y - below;
    const probe = new Funnel({ cx: 0, cz: 0, rimY, radius, depth });
    const land = flyUntil(off, (p, vel) => vel.y < 0 && p.y <= probe.surface(landAt * radius) + R);
    flights.push(land.arc);
    const across = V(-land.v.z * side, 0, land.v.x * side).normalize();
    const c = land.p.clone().addScaledVector(across, landAt * radius);
    const f = new Funnel({ cx: c.x, cz: c.z, rimY, radius, depth });
    f.wall = ring
      ? { angle: 0, span: 2 * Math.PI, height: 0.02, radius: radius + 0.006 }
      : { angle: Math.atan2(land.v.z, land.v.x), span: 1.5, height: 0.05, radius: radius + 0.006 };
    funnels.push(f);
    f.orbit = orbit(f, land).t;
    return f;
  };
  /**
   * The ramp a funnel's spout drops onto, heading `h`: `len` metres falling
   * at `grade`, then a kick up off the end (or straight on into `then`).
   */
  const spoutRamp = (name, f, h, len, grade = 0.12, kick = -0.3) => {
    const holeY = f.surface(f.hole);
    const t = turtle(V(f.cx, holeY - 0.032, f.cz), h, grade);
    t.straight(len, grade);
    if (kick !== null) t.ease(0.035, kick);
    const ramp = lay(name, t, { backstop: true });
    ramp.catch = [0, 0.03];
    ramp.end = { type: 'fly' };
    f.exitTo = ramp;
    flights.push([V(f.cx, holeY, f.cz), ramp.path.at(0)]);
    return ramp;
  };
  /** Search a spout ramp's length so its jump lands in funnel `to` (partway in). */
  const aimRamp = (name, from, to, grade = 0.12, kick = -0.3) => {
    const h = Math.atan2(to.cz - from.cz, to.cx - from.cx);
    const target = (land) => Math.abs(Math.hypot(land.x - to.cx, land.z - to.cz) - 0.55 * to.radius);
    let best = null;
    for (let len = 0.05; len <= 0.2; len += 0.005) {
      const ramp = spoutRamp(name, from, h, len, grade, kick);
      tracks.pop();
      flights.pop();
      const tip = ramp.path.at(ramp.path.length);
      if (Math.hypot(tip.x - to.cx, tip.z - to.cz) < to.radius + 0.012) break;   // stop short of its rim
      const v0 = roll(ramp, SPOUT_V).v;
      const off = launch(ramp, v0);
      try {
        const land = flyUntil(off, (p, vel) => vel.y < 0 && p.y <= to.restY(p.x, p.z) && Math.hypot(p.x - to.cx, p.z - to.cz) < to.radius);
        const miss = target(land.p);
        if (!best || miss < best.miss) best = { len, miss };
      } catch { /* flew past */ }
    }
    if (!best) throw new Error(`${name}: can't reach the next funnel`);
    return spoutRamp(name, from, h, best.len, grade, kick);
  };

  // ---- F2 (outer spiral's exit): loop-the-loop and jump / hills into the funnel cascade ----
  const f2 = end(outer);
  const loopT = turtle(f2.p, E, 0.03);
  loopT.turn(0.055, Math.PI / 2, 0.04);         // left, towards the front
  loopT.turn(0.055, -Math.PI / 2, 0.04);        // and right, heading west again
  loopT.straight(0.02, 0.04).ease(0.12, 0.85).straight(0.1, 0.85).ease(0.07, 0.0).straight(0.02, 0);
  loopT.loop(0.042, -0.042);                    // drifting right, towards the back
  loopT.straight(0.02, 0.0).ease(0.04, -0.38);  // and kick up off the end
  const looper = lay('loop-the-loop', loopT);
  looper.end = { type: 'fly' };

  // Hills westward, then a left turn that carries the marble out over the
  // loop route below, and a kick off the end into the first funnel of the cascade.
  const hillT = turtle(f2.p, E, 0.03);
  hillT.straight(0.04, 0.03).hills(0.18, 2, 0.006, 0.04).straight(0.02, 0.035);
  hillT.turn(0.06, Math.PI / 2, 0.035);
  hillT.straight(0.07, 0.035).ease(0.035, -0.3);
  const hills = lay('hills', hillT);
  hills.end = { type: 'fly' };
  fork(outer, looper, hills);
  const vLoop = run(looper, vOuter);
  const vHills = run(hills, vOuter);

  // The loop's jump lands in the big funnel on the left.
  const funnel = catchIn(looper, vLoop, { radius: 0.072, depth: 0.05, below: 0.05, landAt: 0.62 });
  const orbitTime = funnel.orbit;
  const holeY = funnel.surface(funnel.hole);

  // The cascade along the front: the hills' jump lands in bowl A, which kicks
  // marbles on into B, and B into C.
  const bowlA = catchIn(hills, vHills, { side: -1 });

  // ---- F3 (inner spiral's exit): chime stack / stadium helix ----
  const f3 = end(inner);
  const stack = { z: -0.13, slope: Math.tan((2.6 * Math.PI) / 180), drop: 0.042, left: -0.25, right: 0.17 };
  stack.levels = Math.floor((f3.p.y - 0.29) / 0.0607) + 1;
  if (stack.levels % 2) stack.levels--;    // finish heading east, round to the back run
  const chimeT = turtle(f3.p, E, 0.03);
  const shift = stack.z - f3.p.z, ahead = 0.12;
  const half3 = Math.atan2(Math.abs(shift) / 2, ahead / 2) * 2, r3 = ahead / 2 / Math.sin(half3);
  chimeT.turn(r3, -half3, 0.03);                 // right (heading west): towards the back
  chimeT.turn(r3, half3, 0.03);
  chimeT.straight(chimeT.p.x - stack.left, stack.slope);
  const first = lay('chime stack 1', chimeT);
  first.end = { type: 'fly', wall: true, chime: 0 };

  // Stadium helix: out to the front, two laps, then west and a kick into bowl B.
  const stadT = turtle(f3.p, E, 0.03);
  stadT.straight(0.03, 0.06).turn(0.06, Math.PI / 2, 0.07);     // left, out to the front (under the loop route)
  stadT.turn(0.06, Math.PI / 2, 0.05);                           // left again: heading east
  const st0 = stadT.p.clone();
  stadT.stadium(0.12, 0.06, 2, 0.066);
  stadT.straight(0.12, 0.05).turn(0.06, -Math.PI, 0.05);         // and half a lap more: heading west, along its front
  const stadium = lay('stadium helix', stadT);
  for (const x of [st0.x + 0.12, st0.x]) {
    helixPosts.push({ x, z: st0.z + 0.06, top: st0.y + 0.03, radius: 0.007, tracks: [stadium], coilRadius: 0.06,
      spokes: x === st0.x ? [Math.PI * 0.75, Math.PI * 1.25] : [Math.PI * 0.25, Math.PI * 1.75] });
  }
  fork(inner, first, stadium);
  const vFirst = run(first, vInner);
  const vStadium = run(stadium, vInner);

  // Bowl B: A's spout ramp throws marbles into it from the west, and the
  // stadium's run throws them in from the north-east.
  const sEnd0 = end(stadium);
  const feedT = turtle(sEnd0.p, E, 0.05);
  feedT.straight(0.02, 0.05);
  feedT.turn(0.06, Math.PI / 3, 0.05);           // left, out towards the front
  feedT.ease(0.03, -0.12);
  const feed = lay('stadium feed', feedT);
  feed.end = { type: 'fly' };
  link(stadium, feed);
  const vFeed = run(feed, vStadium);
  const bowlB = catchIn(feed, vFeed, { ring: true, below: 0.04 });
  const rampAB = aimRamp('cascade A-B', bowlA, bowlB);
  run(rampAB, SPOUT_V);
  // Bowl C, east of B, where B's ramp throws marbles.
  const rampBC = spoutRamp('cascade B-C', bowlB, -0.6, 0.1);
  const vBC = run(rampBC, SPOUT_V);
  const bowlC = catchIn(rampBC, vBC, {});

  // Chime stack: each ramp ends at a tuned bar; the marble strikes it and drops to the ramp below.
  const ramps = [first];
  chimes.push({ track: first, note: 0 });
  let prev = first, heading = -1, vr = vFirst;
  for (let level = 2; level <= stack.levels; level++) {
    const off = launch(prev, vr);
    const y = off.p.y - stack.drop;
    const land = flyUntil(off, (p, vel) => vel.y < 0 && p.y <= y);
    flights.push(land.arc);
    heading = -heading;
    const startX = off.p.x - heading * 0.014;
    const endX = heading > 0 ? stack.right : stack.left;
    const startY = y + 0.03 * stack.slope;
    const ramp = add(`chime stack ${level}`, [
      V(startX, startY, stack.z),
      V(endX, startY - Math.abs(endX - startX) * stack.slope, stack.z),
    ], { startDir: [heading, -stack.slope, 0], endDir: [heading, -stack.slope, 0], backstop: true });
    ramp.catch = [0, 0.09];
    ramp.end = { type: 'fly', wall: true, chime: level - 1 };
    vr = roll(ramp, land.v.x * heading, ramp.path.nearest(land.p).s).v;
    ramps.push(ramp);
    if (level < stack.levels) chimes.push({ track: ramp, note: level - 1 });
    prev = ramp;
  }
  const lastRamp = prev;
  lastRamp.end = { type: 'next' };

  // ---- The way home ----
  // Back run: from the bottom of the chime stack along the back, under the top run, to the lift.
  const pick = V(lift.ballX, lift.pickY, lift.z);
  const merge = V(-0.33, 0, -0.2);
  const lr = end(lastRamp);
  const backT = turtle(lr.p, heading > 0 ? 0 : E, stack.slope);
  backT.turn(0.035, heading > 0 ? Math.PI : -Math.PI, 0.03);        // round the end, towards the back
  const back = lay('back run', backT.straight(Math.abs(backT.p.x - merge.x), (backT.p.y - pick.y - 0.012) / Math.abs(backT.p.x - pick.x)));
  merge.copy(back.path.at(back.path.length));
  link(lastRamp, back);
  const vBack = run(back, vr);
  const home = add('to the lift', [merge, pick], { startDir: end(back).dir, endDir: end(back).dir });
  link(back, home);

  // ---- F4, under bowl C: the front collector, or a detour over the waves ----
  // C's spout drops onto a short chute heading west, to the flip-flop.
  const cHole = bowlC.surface(bowlC.hole);
  const cT0 = turtle(V(bowlC.cx, cHole - 0.032, bowlC.cz), E, 0.06);
  cT0.straight(0.05, 0.06);
  const cChute = lay('cascade spout', cT0, { backstop: true });
  cChute.catch = [0, 0.03];
  bowlC.exitTo = cChute;
  flights.push([V(bowlC.cx, cHole, bowlC.cz), cChute.path.at(0)]);
  const vC = run(cChute, SPOUT_V);

  const leftX = -0.315, frontZ = 0.375;
  const f4 = end(cChute);
  // (a) out to the front edge and west along it.
  const aT = turtle(f4.p, E, 0.06);
  sBend(aT, 0.16, frontZ - f4.p.z, 0.06 * 0.18);
  const lenWest = aT.p.x - (leftX + 0.06), lenNorth = frontZ - 0.06 - (merge.z + 0.05);
  const total = lenWest + 0.06 * Math.PI / 2 + lenNorth + 0.05 * Math.PI / 2 + (leftX - 0.05 - merge.x);
  const g = (aT.p.y - merge.y - 0.003) / total;
  const jWaves = -0.2;                                        // where the waves rejoin
  aT.straight(aT.p.x - jWaves, g);
  const colA = lay('front collector', aT);
  // (b) straight on west over a run of waves, under the cascade, and out to rejoin further along.
  const j3 = end(colA);
  const bT = turtle(f4.p, E, 0.06);
  bT.straight(0.02, 0.06).ease(0.03, 0.09).straight(0.03, 0.09);   // a run-up first
  const wavesLen = bT.p.x - j3.p.x - 0.2;
  bT.hills(wavesLen, 3, 0.006, (bT.p.y - j3.p.y - 0.004) / (wavesLen + 0.2));
  sBendTo(bT, j3.p);
  const waves = add('waves', [...bT.points().slice(0, -1), j3.p], { startDir: [-1, -0.06, 0], endDir: j3.dir });
  fork(cChute, colA, waves);

  // ---- Under the big funnel: a little drop stack ----
  // The spout drops onto the first of three short ramps running north and
  // south; the marble strikes the end block of each and falls to the next,
  // and the last joins the left collector.
  const dropT = turtle(V(funnel.cx, holeY - 0.032, funnel.cz), N, 0.05);
  dropT.straight(0.1, 0.05);
  const drop1 = lay('drop stack 1', dropT, { backstop: true });
  drop1.catch = [0, 0.03];
  drop1.end = { type: 'fly', wall: true };
  funnel.exitTo = drop1;
  flights.push([V(funnel.cx, holeY, funnel.cz), drop1.path.at(0)]);
  let vd = run(drop1, SPOUT_V), dPrev = drop1, dHead = N;
  const drops = [drop1];
  for (let k = 2; k <= 4; k++) {
    const off = launch(dPrev, vd);
    const y = off.p.y - 0.05;
    const land = flyUntil(off, (p, vel) => vel.y < 0 && p.y <= y);
    flights.push(land.arc);
    dHead = dHead === N ? S : N;
    const start = off.p.clone().setY(y + 0.002);
    start.z -= Math.sin(dHead) * 0.014;
    const dT = turtle(start, dHead, 0.05);
    dT.straight(k === 4 ? 0.08 : 0.1, 0.05);
    const d = lay(`drop stack ${k}`, dT, { backstop: true });
    d.catch = [0, 0.04];
    d.end = k === 4 ? { type: 'next' } : { type: 'fly', wall: true };
    vd = roll(d, Math.abs(land.v.z), d.path.nearest(land.p).s).v;
    drops.push(d);
    dPrev = d;
  }
  const dEnd = end(dPrev);

  const cT2 = turtle(j3.p, E, g);
  cT2.straight(j3.p.x - (leftX + 0.06), g).turn(0.06, -Math.PI / 2, g);   // right: heading north
  const j2z = dEnd.p.z;                                     // where the funnel's drop stack joins
  cT2.straight(cT2.p.z - j2z, g);
  const colB = lay('left collector', cT2);
  link(colA, colB);
  link(waves, colB);
  const cT3 = turtle(cT2.p, N, g);
  cT3.straight(cT3.p.z - (merge.z + 0.05), g).turn(0.05, Math.PI / 2, g);   // left: heading west, alongside the back run
  cT3.straight(Math.max(0.004, cT3.p.x - merge.x), g);
  const colC = lay('to the merge', cT3);
  link(colB, colC);
  link(colC, home);
  let vCollector = run(colA, vC);
  const vWaves = run(waves, vC);
  vCollector = run(colB, Math.max(vCollector, vWaves));
  vCollector = run(colC, vCollector);

  // From the foot of the drop stack round into the left collector.
  const j2 = end(colB);
  const djR = Math.abs(j2.p.x - dEnd.p.x) / 2;
  // (the turn's grade found by trial, since easing into it costs a little height)
  let djGrade = (dEnd.p.y - j2.p.y) / (Math.PI * djR), dj;
  for (let i = 0; i < 4; i++) {
    dj = turtle(dEnd.p, dHead, 0.05);
    dj.turn(djR, Math.PI, djGrade);   // left round, to heading north
    djGrade += (dj.p.y - j2.p.y) / (Math.PI * djR);
  }
  const dropOut = add('drop stack out', [...dj.points().slice(0, -1), j2.p], { startDir: [0, -0.05, Math.sin(dHead)], endDir: j2.dir });
  link(dPrev, dropOut);
  link(dropOut, colC);
  const vChute = run(dropOut, vd);

  const report = {
    switches: switches.length, jumpLaunch: launch(looper, vLoop), orbit: orbitTime,
    speeds: { vOuter, vInner, vLoop, vHills, vFirst, vStadium, vFeed, vBack, vCollector, vWaves, vChute },
  };

  // Most of the machine is routed track; the open dowel rails are kept where
  // seeing through them shows off the feature (the loop, the bumps) or the
  // track hangs from above (the top run).
  const RAILS = new Set(['top run', 'loop-the-loop', 'hills', 'waves']);
  for (const t of tracks) if (RAILS.has(t.name)) t.style = 'rails';

  lift.from = home;
  lift.to = top;

  return {
    tracks, funnels, switches, lift, flights, chimes, helixPosts, rings,
    spiral: { x: tower.x, z: tower.z, radius: tower.inner },
    stack: { ...stack, ramps },
    drops,
    report,
  };
}
