import * as THREE from 'three';
import { Path, helix, helixDir } from './path.js';
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
  return { v, speed, t };
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
  // Ease the bank in and out over a few centimetres.
  const w = 20;
  for (let i = 0; i < path.count; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(path.count - 1, i + w); j++) { sum += raw[j]; n++; }
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

export function buildLayout() {
  const tracks = [];
  const funnels = [];
  const switches = [];
  const flights = [];   // arcs marbles fly through, kept clear of supports
  const add = (name, points, opts = {}) => {
    const t = new Track(name, new Path(points, opts), opts);
    tracks.push(t);
    return t;
  };
  const link = (a, b) => { a.end = { type: 'next', to: b }; };

  // ---- Paddle-chain lift ----
  const lift = {
    x: -0.30, z: -0.10,          // chain loop centre line (the loop lies in the x-y plane)
    yBottom: 0.07, yTop: 0.66,   // sprocket centres
    radius: 0.024,               // sprocket pitch radius
    speed: 0.12,                 // chain speed, m/s
    spacing: 0.07,               // between paddles along the chain
  };
  lift.ballX = lift.x + lift.radius + 0.011;    // marble centre while it rides a paddle
  lift.pickY = lift.yBottom + 0.04;             // where marbles wait to be picked up
  lift.releaseY = lift.yTop - 0.006;            // where the top run takes them off

  // ---- Top run: from the lift to the spiral tower ----
  const spiral = { x: 0.20, radius: 0.085, slope: Math.tan((4.2 * Math.PI) / 180), turns: 2.5 };
  spiral.z = lift.z + spiral.radius;            // so the top run meets it square
  const a0 = -Math.PI / 2;
  const top = add('top run', [
    V(lift.ballX, lift.releaseY, lift.z),
    V(-0.06, lift.releaseY - 0.016, lift.z),
    V(spiral.x, lift.releaseY - 0.03, lift.z),
  ], { startDir: [1, -0.06, 0], endDir: helixDir(a0, spiral.slope) });

  // ---- Spiral tower, then a short straight to the switch ----
  const entry = top.path.at(top.path.length);
  const a1 = a0 + spiral.turns * 2 * Math.PI;
  const coil = helix(spiral.x, spiral.z, spiral.radius, entry.y, a0, a1, spiral.slope);
  const coilEnd = coil[coil.length - 1];
  const sw = V(coilEnd.x - 0.07, coilEnd.y - 0.004, coilEnd.z);
  const tower = add('spiral', [...coil, sw], { startDir: helixDir(a0, spiral.slope), endDir: [-1, -0.06, 0] });
  link(top, tower);

  let v = roll(top, 0.05);
  bankFor(top, v.speed);
  v = roll(tower, v.v);
  bankFor(tower, v.speed);
  const vSwitch = v.v;

  // ---- Branch A: steep drop, kicker, jump into a funnel ----
  // Out to the front, round two hairpins, then a steep drop heading left
  // and a kicker that throws the marble across the front of the machine.
  const jump = add('jump ramp', [
    sw,
    V(sw.x - 0.055, sw.y - 0.005, sw.z + 0.002),
    V(sw.x - 0.095, sw.y - 0.011, sw.z + 0.015),
    V(sw.x - 0.11, sw.y - 0.017, sw.z + 0.04),
    V(sw.x - 0.095, sw.y - 0.023, sw.z + 0.062),
    V(sw.x - 0.05, sw.y - 0.029, sw.z + 0.07),
    V(sw.x + 0.15, sw.y - 0.044, sw.z + 0.07),
    V(sw.x + 0.2, sw.y - 0.05, sw.z + 0.078),
    V(sw.x + 0.22, sw.y - 0.056, sw.z + 0.098),
    V(sw.x + 0.2, sw.y - 0.062, sw.z + 0.118),
    V(sw.x + 0.15, sw.y - 0.069, sw.z + 0.125),
    V(sw.x + 0.11, sw.y - 0.087, sw.z + 0.125),
    V(sw.x + 0.06, sw.y - 0.132, sw.z + 0.125),
    V(sw.x + 0.025, sw.y - 0.157, sw.z + 0.125),
    V(sw.x + 0.005, sw.y - 0.16, sw.z + 0.125),
  ], { startDir: [-1, -0.06, 0], endDir: [-1, 0.36, 0] });
  jump.end = { type: 'fly' };
  v = roll(jump, vSwitch);
  bankFor(jump, v.speed);

  // Put the funnel where the marble comes down: it lands partway in and
  // across the bowl, so it starts orbiting.
  const bowl = { radius: 0.072, depth: 0.05, landAt: 0.62 };
  const lifted = launch(jump, v.v);
  const rimY = lifted.p.y - 0.045;
  const probe = new Funnel({ cx: 0, cz: 0, rimY, radius: bowl.radius, depth: bowl.depth });
  const landY = probe.surface(bowl.landAt * bowl.radius) + R;
  const landing = flyUntil(lifted, (p, vel) => vel.y < 0 && p.y <= landY);
  flights.push(landing.arc);
  const across = V(-landing.v.z, 0, landing.v.x).normalize();   // to the marble's right, towards the back
  const centre = landing.p.clone().addScaledVector(across, bowl.landAt * bowl.radius);
  const funnel = new Funnel({ cx: centre.x, cz: centre.z, rimY, radius: bowl.radius, depth: bowl.depth });
  // A curved catch wall round the far side stops a marble that jumps long and drops it in.
  const flightDir = Math.atan2(landing.v.z, landing.v.x);
  funnel.wall = { angle: flightDir, span: 1.4, height: 0.075, radius: bowl.radius + 0.006 };
  funnels.push(funnel);
  const out = orbit(funnel, landing);

  // Out of the hole onto a chute below, which carries it to the return run.
  const holeY = funnel.surface(funnel.hole);
  const chuteStart = V(funnel.cx, holeY - 0.035, funnel.cz);
  const chuteDir = V(0, -0.12, -1).normalize();

  // ---- Branch B: switchback stack ----
  const stack = { z: -0.02, slope: Math.tan((4 * Math.PI) / 180), drop: 0.045, left: -0.165, right: 0.045, levels: 4 };
  const first = add('switchback 1', [
    sw,
    V(sw.x - 0.04, sw.y - 0.004, sw.z - 0.015),
    V(sw.x - 0.085, sw.y - 0.009, stack.z + 0.012),
    V(sw.x - 0.12, sw.y - 0.012, stack.z),
    V(stack.left, sw.y - 0.012 - (sw.x - 0.12 - stack.left) * stack.slope, stack.z),
  ], { startDir: [-1, -0.06, 0], endDir: [-1, -stack.slope, 0] });
  first.end = { type: 'fly', wall: true };
  v = roll(first, vSwitch);
  bankFor(first, v.speed);

  let prev = first, heading = -1;
  const ramps = [first];
  for (let level = 2; level <= stack.levels; level++) {
    const off = launch(prev, v.v);
    const y = off.p.y - stack.drop;
    const land = flyUntil(off, (p, vel) => vel.y < 0 && p.y <= y);
    flights.push(land.arc);
    // The next ramp runs back the other way, starting just behind the end block above.
    heading = -heading;
    const startX = off.p.x - heading * 0.014;
    const endX = heading > 0 ? stack.right : stack.left;
    const startY = y + 0.03 * stack.slope;
    const ramp = add(`switchback ${level}`, [
      V(startX, startY, stack.z),
      V(endX, startY - Math.abs(endX - startX) * stack.slope, stack.z),
    ], { startDir: [heading, -stack.slope, 0], endDir: [heading, -stack.slope, 0], backstop: true });
    ramp.catch = [0, 0.09];
    ramp.end = { type: 'fly', wall: true };
    const sLand = ramp.path.nearest(land.p).s;
    v = roll(ramp, land.v.x * heading, sLand);
    ramps.push(ramp);
    prev = ramp;
  }

  // The bottom ramp hands over to a U-turn round the back to the return run.
  const last = prev;
  const lastEnd = last.path.at(last.path.length);
  const uturn = [
    lastEnd,
    V(lastEnd.x + 0.035, lastEnd.y - 0.006, stack.z - 0.012),
    V(lastEnd.x + 0.05, lastEnd.y - 0.012, (stack.z + lift.z) / 2),
    V(lastEnd.x + 0.035, lastEnd.y - 0.018, lift.z + 0.012),
    V(lastEnd.x, lastEnd.y - 0.024, lift.z),
  ];
  const merge = V(-0.205, 0, lift.z);
  const pick = V(lift.ballX, lift.pickY, lift.z);
  // Return run: a steady fall from the U-turn to the lift.
  const fall = (uturn[4].y - pick.y) / (uturn[4].x - pick.x);
  merge.y = pick.y + (merge.x - pick.x) * fall;
  last.end = { type: 'next' };
  const back = add('return run', [...uturn, merge], { startDir: [heading, -stack.slope, 0], endDir: [-1, -fall, 0] });
  last.end.to = back;
  v = roll(back, v.v);
  bankFor(back, v.speed);

  // The funnel's chute joins the return run at the merge, heading the same way.
  // Back under the switchback stack, then a left turn into the merge.
  const chute = add('funnel chute', [
    chuteStart,
    chuteStart.clone().addScaledVector(chuteDir, 0.05),
    V(funnel.cx, merge.y + 0.03, stack.z + 0.02),
    V(funnel.cx - 0.008, merge.y + 0.02, stack.z - 0.035),
    V(funnel.cx - 0.03, merge.y + 0.01, lift.z + 0.014),
    merge,
  ], { startDir: chuteDir, endDir: [-1, -fall, 0], backstop: true });
  chute.catch = [0, 0.03];
  funnel.exitTo = chute;

  const home = add('to the lift', [merge, pick], { startDir: [-1, -fall, 0], endDir: [-1, -fall, 0] });
  home.end = { type: 'stop' };
  link(back, home);
  link(chute, home);

  const vChute = roll(chute, 0.05, 0);
  bankFor(chute, vChute.speed);
  bankFor(home, roll(home, Math.max(v.v, vChute.v) * 0.9).speed);

  switches.push(new Switch(sw, V(-1, 0, 0), [jump, first]));
  tower.end = { type: 'switch', switch: switches[0] };

  lift.from = home;
  lift.to = top;

  // The drop from the funnel's spout onto its chute.
  flights.push([V(funnel.cx, holeY, funnel.cz), chuteStart.clone()]);

  return {
    tracks, funnels, switches, lift, spiral, flights,
    stack: { ...stack, ramps },
    report: { jumpLaunch: lifted, landing: landing.p, funnelTime: out.t, switchSpeed: vSwitch },
  };
}
