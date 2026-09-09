/**
 * Destruction sound effects (Phase 8): tiny procedural WebAudio hits —
 * filtered noise bursts with envelopes, no audio assets. This is a DOM
 * adapter (like the localStorage store): all of it degrades to no-ops
 * when WebAudio is unavailable and stays silent until the first user
 * gesture resumes the context.
 */
export class SoundFx {
  enabled = true;
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  /** Create/resume the context; call from a user gesture (pointer lock). */
  resume(): void {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        const length = Math.floor(this.ctx.sampleRate * 0.6);
        this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null; // stay silent rather than break the game loop
    }
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value && this.ctx) void this.ctx.close();
    if (value) this.resume();
  }

  /** Low filtered burst — chunks landing. */
  thud(intensity = 1): void {
    this.burst({
      type: 'lowpass',
      from: 320,
      to: 120,
      duration: 0.14,
      gain: 0.28 * intensity,
    });
  }

  /** Sharp high burst — structure fracturing. */
  crack(): void {
    this.burst({ type: 'highpass', from: 1400, to: 900, duration: 0.18, gain: 0.3 });
  }

  /** Deep sweep + sub thump — explosions. */
  boom(): void {
    if (!this.playable()) return;
    this.burst({ type: 'lowpass', from: 500, to: 50, duration: 0.65, gain: 0.7 });
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(64, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(32, ctx.currentTime + 0.45);
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  }

  private playable(): boolean {
    return this.enabled && this.ctx !== null && this.noise !== null;
  }

  private burst(opts: {
    type: BiquadFilterType;
    from: number;
    to: number;
    duration: number;
    gain: number;
  }): void {
    if (!this.playable()) return;
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.setValueAtTime(opts.from, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(opts.to, ctx.currentTime + opts.duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + opts.duration);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + opts.duration);
  }
}
