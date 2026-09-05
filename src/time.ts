/** Wall-clock anchors avoid accumulated frame drift and recover after a hidden tab. */
export class SimulationClock {
  private anchorReal: number;
  private anchorSim: number;
  speed = 1;
  paused = false;
  constructor(private now: () => number = Date.now) {
    this.anchorReal = this.anchorSim = now();
  }
  time() { return this.anchorSim + (this.paused ? 0 : (this.now() - this.anchorReal) * this.speed); }
  private anchor(time = this.time()) { this.anchorSim = time; this.anchorReal = this.now(); }
  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || Math.abs(speed) > 100000) return;
    this.anchor(); this.speed = speed;
  }
  setPaused(paused: boolean) { this.anchor(); this.paused = paused; }
  setTime(time: number) { if (Number.isFinite(time) && Math.abs(time) < 8e15) this.anchor(time); }
  returnToLive() { this.speed = 1; this.paused = false; this.anchor(this.now()); }
}

export function formatSpeed(speed: number): string {
  const value = Math.abs(speed);
  // A logarithmic preset can round just below its nominal value.
  const label = value >= 86399.9 ? `${(value / 86400).toFixed(1)} d/s`
    : value >= 3599.99 ? `${(value / 3600).toFixed(1)} h/s`
    : value >= 59.999 ? `${(value / 60).toFixed(1)} min/s` : `${value.toFixed(1)}×`;
  return speed < 0 ? `−${label}` : label;
}
