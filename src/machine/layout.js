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
function sBend(t, forward, side, drop) {
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
  const tower = { x: 0.36, outer: 0.115, inner: 0.06 };
  tower.z = lift.z + tower.outer;
  const top = lay('top run', turtle(V(lift.ballX, lift.releaseY, lift.z), 0, 0.06).ease(0.06, 0.03).straight(0.66 - 0.06 - 0.12 + (0.22 - 0.06), 0.03));
  // (ends at x ≈ 0.22)
  let v = run(top, 0.05);

  // ---- F1: twin concentric spirals round one tower ----
  const f1 = end(top);
  const outerT = turtle(f1.p, 0, 0.03).straight(tower.x - f1.p.x, 0.03);
  outerT.turn(tower.outer, -2.5 * 2 * Math.PI, 0.048);
  outerT.straight(0.09, 0.03);
  const outer = lay('outer spiral', outerT);
  rings.push({ x: tower.x, z: tower.z, radius: tower.outer, postRadius: tower.outer + 0.035, angles: [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75], tracks: [outer] });
  // The inner spiral steps in towards the tower, then winds tighter and faster.
  const innerT = turtle(f1.p, 0, 0.03);
  const dz = tower.outer - tower.inner, run1 = tower.x - f1.p.x;
  const half = Math.atan2(dz / 2, run1 / 2) * 2, rS = run1 / 2 / Math.sin(half);
  innerT.turn(rS, -half, 0.03);
  innerT.turn(rS, half, 0.03);
  innerT.turn(tower.inner, -3.5 * 2 * Math.PI, 0.085);
  innerT.straight(0.09, 0.03);
  const inner = lay('inner spiral', innerT);
  fork(top, outer, inner);
  helixPosts.push({ x: tower.x, z: tower.z, top: f1.p.y + 0.07, radius: 0.012, tracks: [inner], coilRadius: tower.inner });
  const vOuter = run(outer, v);
  const vInner = run(inner, v);

  // ---- F2 (outer spiral's exit): loop-the-loop and jump / hills and helix column ----
  const f2 = end(outer);
  const loopT = turtle(f2.p, E, 0.03);
  loopT.turn(0.055, Math.PI / 2, 0.04);         // left, towards the front
  loopT.turn(0.055, -Math.PI / 2, 0.04);        // and right, heading west again
  loopT.straight(0.02, 0.04).ease(0.12, 0.85).straight(0.07, 0.85).ease(0.07, 0.0).straight(0.02, 0);
  loopT.loop(0.042, -0.034);                            // drifting right, away from the column
  loopT.straight(0.02, 0.0).ease(0.04, -0.38);         // and kick up off the end
  const looper = lay('loop-the-loop', loopT);
  looper.end = { type: 'fly' };

  // Hills westward, then a left turn that carries the marble out over the
  // loop route below, to the top of the helix column at the front.
  const colT = turtle(f2.p, E, 0.03);
  colT.straight(0.04, 0.03).hills(0.18, 2, 0.006, 0.04).straight(0.02, 0.035);
  colT.turn(0.06, Math.PI / 2, 0.035);
  colT.straight(0.19, 0.035);
  const hills = lay('hills', colT);
  fork(outer, looper, hills);
  const vLoop = run(looper, vOuter);
  const vHills = run(hills, vOuter);

  // The jump off the end of the loop lands in a funnel bowl, set where it comes down.
  const bowl = { radius: 0.072, depth: 0.05, landAt: 0.62 };
  const lifted = launch(looper, vLoop);
  const rimY = lifted.p.y - 0.05;
  const probe = new Funnel({ cx: 0, cz: 0, rimY, radius: bowl.radius, depth: bowl.depth });
  const landing = flyUntil(lifted, (p, vel) => vel.y < 0 && p.y <= probe.surface(bowl.landAt * bowl.radius) + R);
  flights.push(landing.arc);
  const across = V(-landing.v.z, 0, landing.v.x).normalize();
  const centre = landing.p.clone().addScaledVector(across, bowl.landAt * bowl.radius);
  const funnel = new Funnel({ cx: centre.x, cz: centre.z, rimY, radius: bowl.radius, depth: bowl.depth });
  funnel.wall = { angle: Math.atan2(landing.v.z, landing.v.x), span: 1.5, height: 0.065, radius: bowl.radius + 0.006 };
  funnels.push(funnel);
  const orbitTime = orbit(funnel, landing).t;

  const holeY = funnel.surface(funnel.hole);

  // ---- F3 (inner spiral's exit): chime stack / stadium helix ----
  const f3 = end(inner);
  const stack = { z: -0.13, slope: Math.tan((2.6 * Math.PI) / 180), drop: 0.042, left: -0.25, right: 0.17, levels: 8 };
  const chimeT = turtle(f3.p, E, 0.03);
  const shift = stack.z - f3.p.z, ahead = 0.12;
  const half3 = Math.atan2(Math.abs(shift) / 2, ahead / 2) * 2, r3 = ahead / 2 / Math.sin(half3);
  chimeT.turn(r3, -half3, 0.03);                 // right (heading west): towards the back
  chimeT.turn(r3, half3, 0.03);
  chimeT.straight(chimeT.p.x - stack.left, stack.slope);
  const first = lay('chime stack 1', chimeT);
  first.end = { type: 'fly', wall: true, chime: 0 };

  const stadT = turtle(f3.p, E, 0.03);
  // Out to the front, dropping quickly at first to pass under the loop route.
  stadT.straight(0.03, 0.06).turn(0.06, Math.PI / 2, 0.07);     // left, out to the front
  stadT.straight(0.13, 0.04);
  stadT.turn(0.06, Math.PI / 2, 0.04);                           // left again: heading east
  const st0 = stadT.p.clone();
  stadT.stadium(0.12, 0.065, 9, 0.06);
  stadT.straight(0.12, 0.05).turn(0.065, -Math.PI / 2, 0.05);    // out of the stadium, right: heading south
  stadT.straight(0.02, 0.05);
  const stadium = lay('stadium helix', stadT);
  // A post at the centre of each half-turn, with arms out to every lap.
  for (const x of [st0.x + 0.12, st0.x]) {
    helixPosts.push({ x, z: st0.z + 0.065, top: st0.y + 0.03, radius: 0.007, tracks: [stadium], coilRadius: 0.065,
      spokes: x === st0.x ? [Math.PI * 0.75, Math.PI * 1.25] : [Math.PI * 0.25, Math.PI * 1.75] });
  }
  fork(inner, first, stadium);
  const vFirst = run(first, vInner);
  const vStadium = run(stadium, vInner);

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

  // ---- Front collector ----
  // From the stadium round to the front edge, west along it, then north up
  // the left side and round into the merge with the back run. It is laid
  // in three pieces so the helix column and the funnel's chute can join it.
  const sEnd = end(stadium);
  const leftX = -0.315, frontZ = Math.min(0.375, sEnd.p.z + 0.1);
  const pieces = [];
  const cT = turtle(sEnd.p, S, 0.05);
  cT.turn(frontZ - cT.p.z, -Math.PI / 2, 0.05);           // right: heading west along the front edge
  // Grade so it arrives at the merge just above the back run's end.
  const lenWest = cT.p.x - (leftX + 0.06), lenNorth = frontZ - 0.06 - (merge.z + 0.05);
  const total = lenWest + 0.06 * Math.PI / 2 + lenNorth + 0.05 * Math.PI / 2 + (leftX - 0.05 - merge.x);
  const g = (cT.p.y - merge.y - 0.003) / total;
  const j1x = leftX + 0.075;                                // where the helix column joins
  cT.straight(cT.p.x - j1x, g);
  const colA = lay('front collector', cT);
  const cT2 = turtle(cT.p, E, g);
  cT2.straight(j1x - (leftX + 0.06), g).turn(0.06, -Math.PI / 2, g);   // right: heading north
  const j2z = funnel.cz - 0.16;                             // where the funnel's corkscrew joins
  cT2.straight(cT2.p.z - j2z, g);
  const colB = lay('left collector', cT2);
  const cT3 = turtle(cT2.p, N, g);
  cT3.straight(cT3.p.z - (merge.z + 0.05), g).turn(0.05, Math.PI / 2, g);   // left: heading west, alongside the back run
  cT3.straight(Math.max(0.004, cT3.p.x - merge.x), g);
  const colC = lay('to the merge', cT3);
  pieces.push(colA, colB, colC);
  link(stadium, colA);
  link(colA, colB);
  link(colB, colC);
  link(colC, home);
  let vCollector = run(colA, vStadium);
  vCollector = run(colB, vCollector);
  vCollector = run(colC, vCollector);

  // The hills run into a helix column at the front, winding down to join the
  // front collector: as many turns as it takes to arrive at the junction's height.
  // It winds to the right (clockwise from above), so after a quarter turn
  // more than a whole number it leaves from its front heading west.
  const hEnd = end(hills);
  const colRadius = 0.075;
  const j1 = end(colA);
  const exitAt = V(hEnd.p.x - colRadius, 0, hEnd.p.z + colRadius);
  const joinLen = exitAt.x - j1.p.x;
  const yExit = j1.p.y + joinLen * 0.06;
  let turns = 0.25;
  while ((hEnd.p.y - yExit) / ((turns + 1) * 2 * Math.PI * colRadius) > 0.066) turns += 1;
  const colGrade = (hEnd.p.y - yExit) / (turns * 2 * Math.PI * colRadius);
  const colT2 = turtle(hEnd.p, S, colGrade);
  const colCentre = colT2.turn(colRadius, -turns * 2 * Math.PI, colGrade);
  // An S-bend out to the collector, falling to meet it.
  sBendTo(colT2, j1.p);
  const column = add('helix column', [...colT2.points().slice(0, -1), j1.p], { startDir: [0, -colGrade, 1], endDir: j1.dir });
  link(hills, column);
  link(column, colB);
  helixPosts.push({ x: colCentre.x, z: colCentre.z, top: hEnd.p.y + 0.03, radius: 0.009, tracks: [column], coilRadius: colRadius });
  const vColumn = run(column, vHills);

  // The funnel's spout drops onto a corkscrew that winds down underneath the
  // bowl and leaves heading north into the left collector.
  const j2 = end(colB);
  const chuteStart = V(funnel.cx, holeY - 0.035, funnel.cz);
  const corkR = 0.058;
  const ckT = turtle(chuteStart, 0, 0.06);
  ckT.turn(corkR / 2, Math.PI, 0.06);                       // out from under the spout to the corkscrew's circle
  const yOut = j2.p.y + 0.012;
  let ckTurns = 0.75;
  while ((ckT.p.y - yOut) / ((ckTurns + 1) * 2 * Math.PI * corkR) > 0.082) ckTurns += 1;
  const ckGrade = (ckT.p.y - yOut) / (ckTurns * 2 * Math.PI * corkR);
  ckT.turn(corkR, ckTurns * 2 * Math.PI, ckGrade);          // left round the funnel's centre
  sBendTo(ckT, j2.p);
  const chute = add('funnel corkscrew', [...ckT.points().slice(0, -1), j2.p], { startDir: [1, -0.06, 0], endDir: j2.dir, backstop: true });
  rings.push({ x: funnel.cx, z: funnel.cz, radius: corkR, postRadius: corkR + 0.032, angles: [Math.PI * 0.5, Math.PI * 1.15, Math.PI * 1.85], tracks: [chute] });
  chute.catch = [0, 0.03];
  funnel.exitTo = chute;
  link(chute, colC);
  flights.push([V(funnel.cx, holeY, funnel.cz), chuteStart.clone()]);
  const vChute = run(chute, 0.05);

  const report = {
    switches: switches.length, jumpLaunch: lifted, orbit: orbitTime,
    speeds: { vOuter, vInner, vLoop, vHills, vColumn, vFirst, vStadium, vBack, vCollector, vChute },
  };

  lift.from = home;
  lift.to = top;

  return {
    tracks, funnels, switches, lift, flights, chimes, helixPosts, rings,
    spiral: { x: tower.x, z: tower.z, radius: tower.inner },
    stack: { ...stack, ramps },
    report,
  };
}
