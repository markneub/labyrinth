import * as THREE from 'three';

// Ordinary earth physics in SI units: a 21 mm glass marble (a little larger
// than the usual 16 mm, so it is easy to follow) on wooden rails or grooves.
export const G = 9.81;
export const R = 0.0105;         // marble radius
export const RAIL_R = 0.003;     // dowel rail radius
export const GAUGE = 0.017;      // rail centre-to-centre
// The marble rests on the two rails: its centre sits this far above them.
export const RIDE = Math.sqrt((R + RAIL_R) ** 2 - (GAUGE / 2) ** 2);
// Rolling on two rails: I / (m ρ²) with ρ the centre's height over the contact line.
export const ROLL = 1 / (1 + (0.4 * R * R) / (RIDE * RIDE));
export const ROLL_FREE = 5 / 7;  // rolling on a surface (funnel bowls)
export const MU = 0.012;         // rolling resistance of a marble on wood
export const DRAG = 0.18;        // speed-squared losses (air, rail rattle), per metre
export const AIR = 0.011;         // air drag alone, for marbles in flight, per metre
export const BOUNCE = 0.45;      // coefficient of restitution against end stops
export const BALL_BOUNCE = 0.8;  // glass on glass

const GRAV = new THREE.Vector3(0, -G, 0);

/** Acceleration along a track at arc length s, moving at v (m/s). */
export function trackAccel(path, s, v) {
  const a = ROLL * G * -path.slope(s);
  const loss = MU * G + DRAG * v * v;
  if (Math.abs(v) > 1e-3) return a - Math.sign(v) * loss;
  // At rest it only starts rolling if gravity beats rolling resistance.
  return Math.abs(a) > MU * G ? a - Math.sign(a) * MU * G : 0;
}

/**
 * A funnel bowl around (cx, cz): the surface rises as 1/r from the hole to
 * the rim, the classic "gravity well" shape that keeps marbles orbiting.
 */
export class Funnel {
  constructor({ cx, cz, rimY, radius = 0.075, hole = 0.013, depth = 0.05 }) {
    Object.assign(this, { cx, cz, rimY, radius, hole, depth });
    this.k = depth / (1 / hole - 1 / radius);
  }

  /** Surface height at radius r. */
  surface(r) {
    const rr = Math.min(this.radius, Math.max(this.hole, r));
    return this.rimY - this.k * (1 / rr - 1 / this.radius);
  }

  /** Slope dy/dr of the surface at radius r. */
  dSurface(r) {
    const rr = Math.min(this.radius, Math.max(this.hole, r));
    return this.k / (rr * rr);
  }

  /** Unit surface normal under (x, z). */
  normal(x, z, out = new THREE.Vector3()) {
    const dx = x - this.cx, dz = z - this.cz, r = Math.hypot(dx, dz) || 1e-6;
    const m = this.dSurface(r);
    return out.set((-m * dx) / r, 1, (-m * dz) / r).normalize();
  }

  /** Height of a marble's centre resting on the surface at (x, z). */
  restY(x, z) {
    const r = Math.hypot(x - this.cx, z - this.cz);
    return this.surface(r) + R / this.normal(x, z, tmpN).y;
  }
}
const tmpN = new THREE.Vector3();
const tmpA = new THREE.Vector3();

/** One step of a marble rolling on a funnel; returns 'exit' when it reaches the hole. */
export function funnelStep(f, p, v, dt) {
  const n = f.normal(p.x, p.z, tmpN);
  // Gravity along the surface, reduced for rolling, less rolling resistance and drag.
  tmpA.copy(GRAV).addScaledVector(n, -GRAV.dot(n)).multiplyScalar(ROLL_FREE);
  const sp = v.length();
  if (sp > 1e-4) tmpA.addScaledVector(v, -(MU * G * n.y + DRAG * sp * sp) / sp);
  v.addScaledVector(tmpA, dt);
  p.addScaledVector(v, dt);
  // Keep it on the surface: inside the rim, resting on the bowl.
  let dx = p.x - f.cx, dz = p.z - f.cz, r = Math.hypot(dx, dz);
  const rimR = f.radius - R;
  if (r > rimR) {
    dx *= rimR / r; dz *= rimR / r; r = rimR;
    p.x = f.cx + dx; p.z = f.cz + dz;
    const vr = (v.x * dx + v.z * dz) / r;
    if (vr > 0) {
      v.x -= (1 + BOUNCE) * vr * dx / r;
      v.z -= (1 + BOUNCE) * vr * dz / r;
    }
  }
  p.y = f.restY(p.x, p.z);
  f.normal(p.x, p.z, n);
  v.addScaledVector(n, -v.dot(n));
  return r < f.hole ? 'exit' : null;
}

/** One step of free flight. */
export function flyStep(p, v, dt) {
  v.addScaledVector(GRAV, dt);
  const sp = v.length();
  if (sp > 1e-4) v.multiplyScalar(1 - AIR * sp * dt);
  p.addScaledVector(v, dt);
}
