import * as THREE from 'three';
import { R, RIDE, BOUNCE, BALL_BOUNCE, trackAccel, funnelStep, flyStep } from './physics.js';
import { bounceOffWall } from './layout.js';

const H = 1 / 1000;           // physics step, seconds
const CATCH_R = 0.012;        // how far off a track's line a falling marble still lands on it
const PADDLE_LIFT = R + 0.003; // marble centre above the chain line on a paddle

/** Where along the lift's chain loop the point at distance u is, and which way the paddle there points. */
export function chainPoint(lift, u, out = { x: 0, y: 0, nx: 0, ny: 0 }) {
  const { x, yBottom, yTop, radius: r } = lift;
  const h = yTop - yBottom, arc = Math.PI * r;
  u = ((u % lift.loop) + lift.loop) % lift.loop;
  if (u < h) return Object.assign(out, { x: x + r, y: yBottom + u, nx: 1, ny: 0 });
  u -= h;
  if (u < arc) {
    const a = u / r;
    return Object.assign(out, { x: x + r * Math.cos(a), y: yTop + r * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  u -= arc;
  if (u < h) return Object.assign(out, { x: x - r, y: yTop - u, nx: -1, ny: 0 });
  const a = Math.PI + (u - h) / r;
  return Object.assign(out, { x: x + r * Math.cos(a), y: yBottom + r * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
}

class Marble {
  constructor(id) {
    this.id = id;
    this.mode = 'track';   // track | fly | funnel | lift
    this.track = null;
    this.s = 0;
    this.v = 0;            // speed along the track
    this.p = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.funnel = null;
    this.paddle = -1;
    this.quat = new THREE.Quaternion();
    this.last = new THREE.Vector3();
    this.contact = new THREE.Vector3(0, 1, 0);  // which way is "up" from what it rolls on
    this.rollR = RIDE;
  }
}

/**
 * The running machine: every marble, the lift and the switches.
 * `update(dt)` advances it in fixed physics steps; `events` collects
 * impacts for sound.
 */
export class Machine {
  constructor(layout, count = 10) {
    this.layout = layout;
    const { lift } = layout;
    lift.loop = 2 * (lift.yTop - lift.yBottom) + 2 * Math.PI * lift.radius;
    lift.paddles = Math.floor(lift.loop / lift.spacing);
    lift.pitch = lift.loop / lift.paddles;
    this.chain = 0;
    this.carry = new Array(lift.paddles).fill(null);
    this.catchers = layout.tracks.filter((t) => t.catch);
    this.time = 0;
    this.acc = 0;
    this.events = [];
    this.stats = { laps: 0, lost: 0, branch: [0, 0] };

    // Start every marble queued on the way to the lift, spaced along it.
    const home = lift.from;
    this.marbles = [];
    for (let i = 0; i < count; i++) {
      const m = new Marble(i);
      m.track = home;
      m.s = Math.max(0, home.path.length - R - i * 2.05 * R);
      if (m.s <= 0) { m.track = home; m.s = 0; }
      home.path.at(m.s, m.p);
      m.last.copy(m.p);
      this.marbles.push(m);
    }
    // Any that don't fit wait further back up the return run.
    // (the longest track feeding the lift's last piece)
    const back = layout.tracks.filter((t) => t.end.to === home).sort((a, b) => b.path.length - a.path.length)[0];
    let spill = 0;
    for (const m of this.marbles) {
      if (m.s > 0 || m === this.marbles[0]) continue;
      m.track = back;
      m.s = back.path.length - R - spill++ * 2.05 * R;
      back.path.at(m.s, m.p);
      m.last.copy(m.p);
    }
  }

  census() {
    const c = {};
    for (const m of this.marbles) c[m.mode] = (c[m.mode] || 0) + 1;
    return c;
  }

  update(dt) {
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= H) {
      this.step(H);
      this.acc -= H;
    }
    for (const m of this.marbles) this.spin(m);
  }

  step(h) {
    this.time += h;
    this.moveLift(h);
    for (const m of this.marbles) {
      if (m.mode === 'track') this.onTrack(m, h);
      else if (m.mode === 'fly') this.inFlight(m, h);
      else if (m.mode === 'funnel') this.inFunnel(m, h);
    }
    this.collide();
  }

  // ---- The lift ----
  moveLift(h) {
    const { lift } = this.layout;
    const before = this.chain;
    this.chain += lift.speed * h;
    const pickU = lift.pickY - PADDLE_LIFT - lift.yBottom;
    const releaseU = lift.releaseY - PADDLE_LIFT - lift.yBottom;
    const cp = {};
    for (let k = 0; k < lift.paddles; k++) {
      const u0 = mod(before + k * lift.pitch, lift.loop), u1 = mod(this.chain + k * lift.pitch, lift.loop);
      if (u1 < u0) continue; // wrapped round the bottom this step
      const carried = this.carry[k];
      if (carried) {
        chainPoint(lift, u1, cp);
        carried.p.set(lift.ballX, cp.y + PADDLE_LIFT, lift.z);
        if (u0 < releaseU && u1 >= releaseU) {
          // Over the top: the top run's rails take the marble as the paddle passes between them.
          this.carry[k] = null;
          carried.mode = 'track';
          carried.track = lift.to;
          carried.s = 0;
          carried.v = 0;
          this.stats.laps++;
        }
      } else if (u0 < pickU && u1 >= pickU) {
        const home = lift.from;
        const waiting = this.marbles.find((m) => m.mode === 'track' && m.track === home &&
          m.s >= home.path.length - R - 0.002 && Math.abs(m.v) < 0.2);
        if (waiting) {
          waiting.mode = 'lift';
          waiting.paddle = k;
          this.carry[k] = waiting;
          this.events.push({ kind: 'pick', p: waiting.p.clone(), strength: 0.3 });
        }
      }
    }
  }

  // ---- Rolling on rails ----
  onTrack(m, h) {
    let path = m.track.path;
    m.v += trackAccel(path, m.s, m.v) * h;
    m.s += m.v * h;
    if (m.s < 0) {
      if (m.track.backstop) {
        if (m.v < -0.15) this.events.push({ kind: 'stop', p: m.p.clone(), strength: -m.v });
        m.s = 0;
        m.v = -m.v * BOUNCE;
      } else {
        m.s = 0;
        m.v = 0;
      }
    }
    for (let hops = 0; m.s >= path.length; hops++) {
      if (hops > 8) throw new Error(`marble ${m.id} stuck at the end of ${m.track.name}: s=${m.s} v=${m.v}`);
      const end = m.track.end;
      if (end.type === 'next' || end.type === 'switch') {
        m.s -= path.length;
        if (end.type === 'switch') {
          const sw = end.switch;
          m.track = sw.branches[sw.state];
          this.stats.branch[sw.state]++;
          sw.state ^= 1;
          sw.flipped = this.time;
          this.events.push({ kind: 'switch', p: m.p.clone(), strength: 0.4 });
        } else {
          m.track = end.to;
        }
        path = m.track.path;
      } else if (end.type === 'fly') {
        m.mode = 'fly';
        m.flewFrom = m.track.name;
        path.at(path.length, m.p);
        path.tangent(path.length, m.vel).multiplyScalar(m.v);
        if (end.wall) {
          this.events.push(end.chime !== undefined
            ? { kind: 'chime', note: end.chime, p: m.p.clone(), strength: m.v }
            : { kind: 'stop', p: m.p.clone(), strength: m.v });
          bounceOffWall(m.vel);
        }
        return;
      } else {
        // The stop block at the lift.
        if (m.v > 0.15) this.events.push({ kind: 'stop', p: m.p.clone(), strength: m.v });
        m.s = path.length - 1e-6;
        m.v = Math.min(0, -m.v * BOUNCE * 0.5);
        break;
      }
    }
    path.at(m.s, m.p);
    const f = path.frame(m.s, tmpFrame);
    m.contact.copy(f.u);
    m.rollR = RIDE;
  }

  // ---- Flying ----
  inFlight(m, h) {
    flyStep(m.p, m.vel, h);
    for (const f of this.layout.funnels) {
      if (f.wall && this.hitWall(m, f)) break;
    }
    for (const f of this.layout.funnels) {
      if (f === m.dropped) continue;   // just fell through this one's hole
      const r = Math.hypot(m.p.x - f.cx, m.p.z - f.cz);
      const rest = f.restY(m.p.x, m.p.z);
      // (coming down onto the surface, not passing underneath the bowl)
      if (r < f.radius - R && r > f.hole + R && m.vel.y < 0 && m.p.y <= rest && m.p.y > rest - 0.01) {
        const n = f.normal(m.p.x, m.p.z, tmpV);
        this.events.push({ kind: 'land', p: m.p.clone(), strength: -m.vel.dot(n) });
        m.vel.addScaledVector(n, -m.vel.dot(n));
        m.p.y = rest;
        m.mode = 'funnel';
        m.funnel = f;
        m.dropped = null;
        return;
      }
    }
    for (const t of this.catchers) {
      const { s, d2 } = t.path.nearest(m.p, t.catch[0], t.catch[1]);
      if (d2 > CATCH_R * CATCH_R * 4) continue;
      const at = t.path.at(s, tmpV);
      const lateral = Math.hypot(m.p.x - at.x, m.p.z - at.z);
      if (m.vel.y < 0 && lateral < CATCH_R && m.p.y <= at.y + 0.001) {
        const tan = t.path.tangent(s, tmpT);
        this.events.push({ kind: 'land', p: m.p.clone(), strength: Math.abs(m.vel.y) });
        m.mode = 'track';
        m.track = t;
        m.s = s;
        m.v = m.vel.dot(tan);
        m.dropped = null;
        return;
      }
    }
    if (m.p.y < -0.05) this.lose(m);
  }

  /** Bounce off a funnel's curved catch wall if the marble reaches it from inside. */
  hitWall(m, f) {
    const w = f.wall;
    const dx = m.p.x - f.cx, dz = m.p.z - f.cz, r = Math.hypot(dx, dz);
    if (r < w.radius - R || r > w.radius + R || m.p.y < f.rimY - 0.01 || m.p.y > f.rimY + w.height) return false;
    let off = Math.atan2(dz, dx) - w.angle;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    if (Math.abs(off) > w.span / 2) return false;
    const nx = dx / r, nz = dz / r;
    const vr = m.vel.x * nx + m.vel.z * nz;
    if (vr <= 0) return false;
    m.vel.x -= (1 + BOUNCE) * vr * nx;
    m.vel.z -= (1 + BOUNCE) * vr * nz;
    m.p.x = f.cx + nx * (w.radius - R);
    m.p.z = f.cz + nz * (w.radius - R);
    this.events.push({ kind: 'stop', p: m.p.clone(), strength: vr });
    return true;
  }

  // ---- Orbiting in a funnel ----
  inFunnel(m, h) {
    const f = m.funnel;
    if (funnelStep(f, m.p, m.vel, h) === 'exit') {
      // Down the spout: it drops straight through onto the chute below.
      m.mode = 'fly';
      m.flewFrom = 'funnel spout';
      m.dropped = f;
      m.p.x = f.cx;
      m.p.z = f.cz;
      m.vel.set(0, Math.min(m.vel.y, -0.1), 0);
      return;
    }
    m.contact.copy(f.normal(m.p.x, m.p.z, tmpV));
    m.rollR = R;
  }

  /** A marble that fell off somewhere (shouldn't happen) rejoins the queue. */
  lose(m) {
    this.stats.lost++;
    (this.stats.losses ||= []).push({ from: m.flewFrom, at: m.p.clone(), t: this.time });
    m.mode = 'track';
    m.track = this.layout.lift.from;
    m.s = 0;
    m.v = 0;
  }

  // ---- Marbles bumping into each other ----
  collide() {
    const ms = this.marbles;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j];
        if (a.mode === 'track' && b.mode === 'track') this.collideOnTrack(a, b);
        else if (a.mode !== 'lift' && b.mode !== 'lift' && a.mode !== 'track' && b.mode !== 'track') this.collideFree(a, b);
      }
    }
  }

  collideOnTrack(a, b) {
    // Distance from a to b measured along the track, where they're on the same or adjoining pieces.
    let gap;
    if (a.track === b.track) gap = b.s - a.s;
    else if (follows(a.track, b.track)) gap = a.track.path.length - a.s + b.s;
    else if (follows(b.track, a.track)) gap = -(b.track.path.length - b.s + a.s);
    else return;
    if (Math.abs(gap) >= 2 * R) return;
    const [back, front] = gap >= 0 ? [a, b] : [b, a];
    const push = (2 * R - Math.abs(gap)) / 2;
    back.s = Math.max(0, back.s - push);
    front.s = Math.min(front.track.path.length, front.s + push);
    const closing = back.v - front.v;
    if (closing > 0) {
      const dv = ((1 + BALL_BOUNCE) / 2) * closing;
      back.v -= dv;
      front.v += dv;
      if (closing > 0.1) this.events.push({ kind: 'clack', p: front.p.clone(), strength: closing });
    }
  }

  collideFree(a, b) {
    const d = tmpV.subVectors(b.p, a.p);
    const dist = d.length();
    if (dist >= 2 * R || dist < 1e-9) return;
    d.divideScalar(dist);
    const push = (2 * R - dist) / 2;
    a.p.addScaledVector(d, -push);
    b.p.addScaledVector(d, push);
    const closing = a.vel.dot(d) - b.vel.dot(d);
    if (closing > 0) {
      const dv = ((1 + BALL_BOUNCE) / 2) * closing;
      a.vel.addScaledVector(d, -dv);
      b.vel.addScaledVector(d, dv);
      if (closing > 0.1) this.events.push({ kind: 'clack', p: b.p.clone(), strength: closing });
    }
  }

  /** Turn each marble to match how far it rolled since last frame. */
  spin(m) {
    const d = tmpV.subVectors(m.p, m.last);
    const dist = d.length();
    if (dist > 1e-6 && dist < 0.05 && m.mode !== 'fly' && m.mode !== 'lift') {
      const axis = tmpT.crossVectors(m.contact, d).normalize();
      tmpQ.setFromAxisAngle(axis, dist / m.rollR);
      m.quat.premultiply(tmpQ);
    }
    m.last.copy(m.p);
  }
}

function follows(a, b) {
  const e = a.end;
  return (e.type === 'next' && e.to === b) || (e.type === 'switch' && e.switch.branches.includes(b));
}

const mod = (a, n) => ((a % n) + n) % n;
const tmpV = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpFrame = { t: new THREE.Vector3(), l: new THREE.Vector3(), u: new THREE.Vector3() };
