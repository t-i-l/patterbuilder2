// Kleiner gedämpfter Feder-Helper für den rAF-Loop.
export const reducedMotion =
  window.matchMedia('(prefers-reduced-motion: reduce)');

export class Spring {
  // zeta = Dämpfungsgrad. 1 = kritisch gedämpft: smooth, ohne Überschwingen.
  constructor(value = 0, { stiffness = 300, zeta = 1, precision = 0.01 } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.precision = precision;
    this.configure(stiffness, zeta);
  }

  configure(stiffness, zeta = 1) {
    this.baseStiffness = stiffness;
    this.zeta = zeta;
    return this;
  }

  // Bei reduzierter Bewegung: schneller, nie unter kritischer Dämpfung
  get k() { return reducedMotion.matches ? Math.max(this.baseStiffness, 600) : this.baseStiffness; }
  get c() { return 2 * Math.sqrt(this.k) * (reducedMotion.matches ? Math.max(1, this.zeta) : this.zeta); }

  set(v) { this.value = this.target = v; this.velocity = 0; return this; }
  to(v)  { this.target = v; return this; }

  step(dt) {
    const k = this.k, c = this.c;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    if (this.done) { this.value = this.target; this.velocity = 0; }
  }

  get done() {
    return Math.abs(this.velocity) < this.precision &&
           Math.abs(this.value - this.target) < this.precision;
  }
}

// Zentraler rAF-Loop: Abonnenten liefern true, solange sie noch laufen.
const tasks = new Set();
let running = false, last = 0;

function frame(t) {
  const dt = Math.min((t - last) / 1000, 1 / 30) || 1 / 60;
  last = t;
  for (const fn of [...tasks]) {
    if (!fn(dt)) tasks.delete(fn);
  }
  if (tasks.size) requestAnimationFrame(frame);
  else running = false;
}

export function animate(fn) {
  tasks.add(fn);
  if (!running) {
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }
}
