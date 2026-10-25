// Tilt input: phone orientation sensor first, then drag / keyboard fallbacks.
// Tilt is reported in radians around the screen axes: x > 0 rolls the ball
// right, z > 0 rolls it toward the bottom of the screen.

const KEYS = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DEG = Math.PI / 180;

function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((a % 360) + 360) % 360;
}

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class TiltInput {
  constructor(surface, maxTilt) {
    this.maxTilt = maxTilt;
    this.tilt = { x: 0, z: 0 };
    this.sensor = null;   // calibrated sensor tilt, radians
    this.gravity = null;  // latest gravity direction in screen space
    this.frame = null;    // calibration frame: { ex, ez }
    this.keys = new Set();
    this.drag = null;
    this.dragTilt = { x: 0, z: 0 };
    this._onOrient = this._onOrient.bind(this);

    addEventListener('keydown', (e) => {
      if (KEYS[e.code]) { this.keys.add(e.code); e.preventDefault(); }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    surface.addEventListener('pointerdown', (e) => {
      if (this.sensor) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      surface.setPointerCapture(e.pointerId);
    });
    surface.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const s = Math.min(innerWidth, innerHeight) * 0.3;
      this.dragTilt.x = clamp((e.clientX - this.drag.x) / s, -1, 1) * maxTilt;
      this.dragTilt.z = clamp((e.clientY - this.drag.y) / s, -1, 1) * maxTilt;
    });
    const end = (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      this.dragTilt.x = this.dragTilt.z = 0;
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);

    const recal = () => this.calibrate();
    screen.orientation?.addEventListener?.('change', recal);
    addEventListener('orientationchange', recal);
  }

  /** Must be called from a user gesture (iOS asks for permission). */
  async enableSensors() {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    // Listen regardless of the permission answer: some browsers expose
    // requestPermission but still deliver events, and a denial simply means
    // none arrive.
    addEventListener('deviceorientation', this._onOrient);
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') return true;
    try {
      return (await DeviceOrientationEvent.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  /** Treat the way the phone is held right now as "level". */
  calibrate() {
    this.frame = null;
    this.sensor = this.sensor && { x: 0, z: 0 };
  }

  _onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    // Gravity in device coordinates (x right, y up the screen, z out of it),
    // derived from the Z-X'-Y'' Euler angles. Unlike raw beta/gamma this
    // stays continuous when the phone is held near vertical.
    const b = e.beta * DEG, g = e.gamma * DEG;
    const dx = Math.cos(b) * Math.sin(g), dy = -Math.sin(b), dz = -Math.cos(b) * Math.cos(g);
    // Rotate into screen space for landscape orientations.
    const a = screenAngle() * DEG;
    const grav = norm([dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a), dz]);
    this.gravity = grav;

    if (!this.frame) {
      // Board axes perpendicular to the calibration "down": screen right and
      // screen down, each projected onto the plane.
      const n = grav;
      const right = [1, 0, 0], down = [0, -1, 0];
      const ex = norm(right.map((v, i) => v - dot(right, n) * n[i]));
      const ez = norm(down.map((v, i) => v - dot(down, n) * n[i] - dot(down, ex) * ex[i]));
      this.frame = { ex, ez };
    }
    this.sensor = {
      x: Math.asin(clamp(dot(grav, this.frame.ex), -1, 1)),
      z: Math.asin(clamp(dot(grav, this.frame.ez), -1, 1)),
    };
  }

  update(dt) {
    let tx = 0, tz = 0;
    if (this.keys.size) {
      for (const k of this.keys) { tx += KEYS[k][0]; tz += KEYS[k][1]; }
      tx = clamp(tx, -1, 1) * this.maxTilt * 0.75;
      tz = clamp(tz, -1, 1) * this.maxTilt * 0.75;
    } else if (this.drag) {
      tx = this.dragTilt.x;
      tz = this.dragTilt.z;
    } else if (this.sensor) {
      tx = this.sensor.x;
      tz = this.sensor.z;
    }
    tx = clamp(tx, -this.maxTilt, this.maxTilt);
    tz = clamp(tz, -this.maxTilt, this.maxTilt);
    // Light smoothing takes the jitter out of the sensor without feeling laggy.
    const k = 1 - Math.exp(-dt * 18);
    this.tilt.x += (tx - this.tilt.x) * k;
    this.tilt.z += (tz - this.tilt.z) * k;
  }
}
