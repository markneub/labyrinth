// Small synthesized sound kit: rolling rumble, wall clicks, falls, win chime.
export class Sfx {
  constructor() {
    this.ctx = null;
  }

  /** Call from a user gesture so mobile browsers allow audio. */
  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 200;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    src.connect(this.rollFilter).connect(this.rollGain).connect(this.master);
    src.start();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend();
      else ctx.resume();
    });
  }

  roll(speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, s = Math.min(speed / 15, 1);
    this.rollGain.gain.setTargetAtTime(s * s * 0.5, t, 0.04);
    this.rollFilter.frequency.setTargetAtTime(140 + s * 700, t, 0.05);
  }

  /** strength 0..1 */
  hit(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000 + Math.random() * 900;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(strength * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, 0.08);

    // Woody body under the click.
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(260, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(strength * 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  fall() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.55);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 280;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.setValueAtTime(0.9, t + 0.4);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(lp).connect(ng).connect(this.master);
    src.start(t, 0, 0.7);
  }

  win() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const s = t + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setValueAtTime(0.2, s);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.5);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(s + 0.55);
    });
  }
}
