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
   * @param {{ startDir?: number[]|THREE.Vector3, endDir?: number[]|THREE.Vector3 }} opts
   */
  constructor(points, { startDir, endDir } = {}) {
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
    out.l.set(0, 1, 0).cross(out.t);
    if (out.l.lengthSq() < 1e-8) out.l.set(1, 0, 0);
    out.l.normalize();
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
