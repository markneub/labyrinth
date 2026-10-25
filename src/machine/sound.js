// Synthesised machine sounds: a woody knock when a marble hits a stop or
// lands, a bright clack when marbles touch, a click from the switches, the
// tuned bars of the chime stack, and a soft rumble that grows with how much
// is rolling. Quieter further away.

export class MachineSound {
  constructor() {
    this.ctx = null;
    this.on = false;
  }

  toggle() {
    if (!this.ctx) this.init();
    this.on = !this.on;
    if (this.ctx) {
      if (this.on) this.ctx.resume();
      this.master.gain.setTargetAtTime(this.on ? 0.9 : 0, this.ctx.currentTime, 0.05);
    }
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 420;
    this.rumble = ctx.createGain();
    this.rumble.gain.value = 0;
    src.connect(this.rumbleFilter).connect(this.rumble).connect(this.master);
    src.start();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend(); else if (this.on) ctx.resume();
    });
  }

  play(machine, camera) {
    const events = machine.events;
    if (!this.ctx || !this.on) { events.length = 0; return; }
    const t = this.ctx.currentTime;
    let played = 0;
    for (const e of events) {
      if (played++ > 6) break;   // don't machine-gun when lots happen at once
      const near = 1 / (1 + 4 * camera.position.distanceTo(e.p));
      const k = Math.min(1, e.strength) * near;
      if (k < 0.02) continue;
      if (e.kind === 'chime') this.chime(t, Math.max(k, 0.25 * near), e.note);
      else if (e.kind === 'clack') this.clack(t, k);
      else if (e.kind === 'switch') this.knock(t, k * 0.6, 2400);
      else this.knock(t, k, e.kind === 'land' ? 900 : 1400);
    }
    events.length = 0;
    let rolling = 0;
    for (const m of machine.marbles) {
      if (m.mode === 'track') rolling += Math.abs(m.v);
      else if (m.mode === 'funnel') rolling += m.vel.length();
    }
    this.rumble.gain.setTargetAtTime(Math.min(0.35, rolling * 0.04), t, 0.1);
  }

  knock(t, k, freq) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * (0.9 + Math.random() * 0.2);
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(k * 1.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.8, 0.07);
  }

  /** A struck brass bar: a pentatonic scale descending with the stack. */
  chime(t, k, note) {
    const scale = [1046.5, 880, 783.99, 659.25, 587.33, 523.25, 440, 392];
    const f = scale[note % scale.length];
    for (const [mult, amp, decay] of [[1, 0.35, 1.4], [2.76, 0.12, 0.5], [5.4, 0.05, 0.2]]) {
      const osc = this.ctx.createOscillator();
      osc.frequency.value = f * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(k * amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  }

  clack(t, k) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = 3200 + Math.random() * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(k * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.05);
  }
}
