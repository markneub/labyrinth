import * as THREE from 'three';

const STEP = 0.001;   // metres between resampled points

/**
 * A smooth path for a marble's centre through waypoints: cubic Hermite
 * segments with chord-length tangents (so uneven spacing doesn't overshoot),
 * resampled every STEP metres of arc length for fast lookups.
 */
export class Path {
  /**
   * @param {Array<THREE.Vector3|number[]>} points
   * @param {{ startDir?: number[]|THREE.Vector3, endDir?: number[]|THREE.Vector3, transport?: boolean }} opts
   *   transport: carry the rails' sideways direction along the path instead of
   *   keeping it horizontal, for tracks that go vertical (a loop-the-loop).
   */
  constructor(points, { startDir, endDir, transport = false } = {}) {
    const P = points.map(toVec);
    const n = P.length;
    const dir = P.map((p, i) => {
      if (i === 0 && startDir) return toVec(startDir).normalize();
      if (i === n - 1 && endDir) return toVec(endDir).normalize();
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      return b.clone().sub(a).normalize();
    });

    // Dense samples along each Hermite segment.
    const dense = [P[0].clone()];
    const h = new THREE.Vector3();
    for (let i = 0; i < n - 1; i++) {
      const len = P[i].distanceTo(P[i + 1]);
      const m0 = dir[i].clone().multiplyScalar(len), m1 = dir[i + 1].clone().multiplyScalar(len);
      const k = Math.max(4, Math.ceil(len / (STEP / 4)));
      for (let j = 1; j <= k; j++) {
        const t = j / k, t2 = t * t, t3 = t2 * t;
        h.set(0, 0, 0)
          .addScaledVector(P[i], 2 * t3 - 3 * t2 + 1)
          .addScaledVector(m0, t3 - 2 * t2 + t)
          .addScaledVector(P[i + 1], -2 * t3 + 3 * t2)
          .addScaledVector(m1, t3 - t2);
        dense.push(h.clone());
      }
    }

    // Resample by arc length.
    const cum = [0];
    for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + dense[i].distanceTo(dense[i - 1]));
    this.length = cum[cum.length - 1];
    const count = Math.max(2, Math.ceil(this.length / STEP) + 1);
    this.step = this.length / (count - 1);
    this.pos = new Float32Array(count * 3);
    for (let i = 0, j = 0; i < count; i++) {
      const s = i * this.step;
      while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      h.lerpVectors(dense[j], dense[j + 1], Math.min(1, Math.max(0, f)));
      this.pos.set([h.x, h.y, h.z], i * 3);
    }
    this.count = count;

    // Unit tangents, and signed horizontal curvature (positive turning left
    // when seen from above) for banking.
    this.tan = new Float32Array(count * 3);
    this.curv = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1), b = Math.min(count - 1, i + 1);
      const t = new THREE.Vector3(
        this.pos[b * 3] - this.pos[a * 3],
        this.pos[b * 3 + 1] - this.pos[a * 3 + 1],
        this.pos[b * 3 + 2] - this.pos[a * 3 + 2],
      ).normalize();
      this.tan.set([t.x, t.y, t.z], i * 3);
    }
    const span = 6;
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - span), b = Math.min(count - 1, i + span);
      const ax = this.tan[a * 3], az = this.tan[a * 3 + 2], bx = this.tan[b * 3], bz = this.tan[b * 3 + 2];
      const ha = Math.atan2(az, ax), hb = Math.atan2(bz, bx);
      let dh = hb - ha;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      const ds = (b - a) * this.step || 1;
      this.curv[i] = -dh / ds;  // atan2(z, x) grows clockwise seen from above (+y)
    }
    this.bank = new Float32Array(count);   // filled in by the layout from the test run

    if (transport) {
      // Parallel-transport the lateral: start horizontal, then only ever turn
      // it as much as the tangent forces.
      this.lat = new Float32Array(count * 3);
      const t = new THREE.Vector3(this.tan[0], this.tan[1], this.tan[2]);
      const l = new THREE.Vector3(0, 1, 0).cross(t).normalize();
      for (let i = 0; i < count; i++) {
        t.set(this.tan[i * 3], this.tan[i * 3 + 1], this.tan[i * 3 + 2]);
        l.addScaledVector(t, -l.dot(t)).normalize();
        this.lat.set([l.x, l.y, l.z], i * 3);
      }
      this.curv.fill(0);
    }
  }

  index(s) {
    return Math.min(this.count - 1, Math.max(0, s / this.step));
  }

  /** Position at arc length s (clamped to the ends). */
  at(s, out = new THREE.Vector3()) {
    const f = this.index(s), i = Math.min(this.count - 2, Math.floor(f)), t = f - i;
    const p = this.pos;
    return out.set(
      p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * t,
      p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * t,
      p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * t,
    );
  }

  /** Unit tangent at arc length s. */
  tangent(s, out = new THREE.Vector3()) {
    const i = Math.round(this.index(s));
    return out.set(this.tan[i * 3], this.tan[i * 3 + 1], this.tan[i * 3 + 2]);
  }

  /** Vertical slope component of the tangent (negative going downhill). */
  slope(s) {
    return this.tan[Math.round(this.index(s)) * 3 + 1];
  }

  bankAt(s) {
    return this.bank[Math.round(this.index(s))];
  }

  /**
   * Frame for the rails at s: tangent, lateral (to the left when looking
   * along the path) and up, tilted by the bank angle.
   */
  frame(s, out = { t: new THREE.Vector3(), l: new THREE.Vector3(), u: new THREE.Vector3() }) {
    this.tangent(s, out.t);
    if (this.lat) {
      const i = Math.round(this.index(s));
      out.l.set(this.lat[i * 3], this.lat[i * 3 + 1], this.lat[i * 3 + 2]);
    } else {
      out.l.set(0, 1, 0).cross(out.t);
      if (out.l.lengthSq() < 1e-8) out.l.set(1, 0, 0);
      out.l.normalize();
    }
    out.u.crossVectors(out.t, out.l).normalize();
    const b = this.bankAt(s);
    if (b) {
      // Positive bank lifts the right-hand rail (outside of a left turn).
      out.l.applyAxisAngle(out.t, -b);
      out.u.applyAxisAngle(out.t, -b);
    }
    return out;
  }

  /** Nearest arc length to point p within [s0, s1], and the squared distance. */
  nearest(p, s0 = 0, s1 = this.length) {
    const i0 = Math.floor(this.index(s0)), i1 = Math.ceil(this.index(s1));
    let best = i0, bestD = Infinity;
    for (let i = i0; i <= i1; i++) {
      const dx = this.pos[i * 3] - p.x, dy = this.pos[i * 3 + 1] - p.y, dz = this.pos[i * 3 + 2] - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { s: best * this.step, d2: bestD };
  }
}

function toVec(v) {
  return v.isVector3 ? v.clone() : new THREE.Vector3(v[0], v[1], v[2]);
}

/** Waypoints along a helix around (cx, cz), from angle a0 to a1 (radians), descending at `slope` (rise/run). */
export function helix(cx, cz, radius, y0, a0, a1, slope, stepAngle = Math.PI / 16) {
  const pts = [];
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / stepAngle));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(new THREE.Vector3(cx + radius * Math.cos(a), y0 - Math.abs(a - a0) * radius * slope, cz + radius * Math.sin(a)));
  }
  return pts;
}

/** Direction of travel on that helix at angle a. */
export function helixDir(a, slope, sign = 1) {
  return new THREE.Vector3(-Math.sin(a) * sign, -slope, Math.cos(a) * sign).normalize();
}

/**
 * Lays out a track like a turtle: straight runs, turns and spirals of a given
 * radius, and humps, each falling at a grade (drop per metre travelled
 * horizontally), so consecutive pieces always join smoothly.
 * Heading h is the angle of travel in the x-z plane (atan2(z, x)); a turn
 * with a positive angle bends to the left (towards decreasing h).
 */
const MAX_BEND = 2.5;   // fastest a turtle's grade may change, per metre

export class Turtle {
  constructor(pos, heading) {
    this.p = toVec(pos);
    this.h = heading;
    this.grade = 0;
    this.pts = [this.p.clone()];
  }

  dir(grade = this.grade) {
    return new THREE.Vector3(Math.cos(this.h), -grade, Math.sin(this.h)).normalize();
  }

  /** Centre of a turn of radius r starting now (left for a positive angle). */
  centre(r, angle) {
    const side = Math.sign(angle) || 1;
    return new THREE.Vector3(this.p.x + Math.sin(this.h) * r * side, this.p.y, this.p.z - Math.cos(this.h) * r * side);
  }

  /**
   * Advance ds metres, turning by dh. The grade moves towards `grade` no
   * faster than MAX_BEND per metre, so slope changes are always gradual
   * enough for a marble to stay on the rails; `exact` skips that (for
   * pieces that shape the grade themselves).
   */
  step(ds, dh, grade, exact = false) {
    if (!exact) grade = Math.max(this.grade - MAX_BEND * ds, Math.min(this.grade + MAX_BEND * ds, grade));
    this.h += dh / 2;
    this.p.x += Math.cos(this.h) * ds;
    this.p.z += Math.sin(this.h) * ds;
    this.p.y -= grade * ds;
    this.h += dh / 2;
    this.grade = grade;
    this.pts.push(this.p.clone());
  }

  straight(len, grade = this.grade) {
    const n = Math.max(1, Math.ceil(len / 0.01));
    for (let i = 0; i < n; i++) this.step(len / n, 0, grade);
    return this;
  }

  /** Turn through `angle` radians on radius r (positive = left). Returns the turn's centre. */
  turn(r, angle, grade = this.grade) {
    const centre = this.centre(r, angle);
    const len = Math.abs(angle) * r;
    const n = Math.max(2, Math.ceil(len / 0.008));
    for (let i = 0; i < n; i++) this.step(len / n, -angle / n, grade);
    return centre;
  }

  /** Ease the grade from its current value to `grade` over len metres. */
  ease(len, grade) {
    const g0 = this.grade, n = Math.max(2, Math.ceil(len / 0.01));
    for (let i = 0; i < n; i++) this.step(len / n, 0, g0 + ((grade - g0) * (i + 0.5)) / n, true);
    this.grade = grade;
    return this;
  }

  /** Humps: `count` smooth bumps of height `height` over len, on top of the base grade. */
  hills(len, count, height, grade = this.grade) {
    const n = Math.max(4, Math.ceil(len / 0.005));
    const k = (2 * Math.PI * count) / len;
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * len;
      // Height profile h(x) = height * (1 - cos kx) / 2 rising and falling: slope = -dh/dx.
      this.step(len / n, 0, grade - (height / 2) * k * Math.sin(k * x), true);
    }
    this.grade = grade;
    return this;
  }

  /**
   * A vertical loop-the-loop of radius r, drifting `shift` metres sideways
   * (to the left) so the way out passes beside the way in.
   */
  loop(r, shift) {
    const p0 = this.p.clone(), fx = Math.cos(this.h), fz = Math.sin(this.h);
    const lx = Math.sin(this.h), lz = -Math.cos(this.h);   // left
    const n = Math.ceil((2 * Math.PI * r) / 0.004);
    for (let i = 1; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      const f = r * Math.sin(a), up = r * (1 - Math.cos(a)), side = (shift * (a - Math.sin(a))) / (2 * Math.PI);
      this.p.set(p0.x + fx * f + lx * side, p0.y + up, p0.z + fz * f + lz * side);
      this.pts.push(this.p.clone());
    }
    this.grade = 0;
    this.looped = true;
    return this;
  }

  /**
   * A racetrack-shaped helix: `laps` times round two straights of length len
   * joined by half-turns of radius r, turning to the right, falling at grade.
   */
  stadium(len, r, laps, grade) {
    for (let i = 0; i < laps; i++) {
      this.straight(len, grade);
      this.turn(r, -Math.PI, grade);
      this.straight(len, grade);
      this.turn(r, -Math.PI, grade);
    }
    return this;
  }

  points() { return this.pts.map((p) => p.clone()); }
  start() { return this.pts[0].clone(); }
}
