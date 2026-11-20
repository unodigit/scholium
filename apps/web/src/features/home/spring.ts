export interface SpringOptions {
  response?: number;
  damping?: number;
  value?: number;
  target?: number;
  velocity?: number;
}

export class Spring {
  private _value: number;
  private _velocity: number;
  private _target: number;
  private _response: number;
  private _damping: number;

  constructor(responseOrOptions?: number | SpringOptions, damping?: number) {
    let response = 0.5;
    let damp = 1;
    let value = 0;
    let target = 0;
    let velocity = 0;

    if (typeof responseOrOptions === "number") {
      response = responseOrOptions;
      if (typeof damping === "number") damp = damping;
    } else if (responseOrOptions && typeof responseOrOptions === "object") {
      response = responseOrOptions.response ?? response;
      damp = responseOrOptions.damping ?? damp;
      value = responseOrOptions.value ?? value;
      target = responseOrOptions.target ?? target;
      velocity = responseOrOptions.velocity ?? velocity;
    }

    this._response = Math.max(0.001, response);
    this._damping = Math.max(0, damp);
    this._value = value;
    this._target = target;
    this._velocity = velocity;
  }

  get response(): number { return this._response; }
  set response(v: number) { this._response = Math.max(0.001, v); }

  get damping(): number { return this._damping; }
  set damping(v: number) { this._damping = Math.max(0, v); }

  get value(): number { return this._value; }
  set value(v: number) { this._value = v; }

  get velocity(): number { return this._velocity; }
  set velocity(v: number) { this._velocity = v; }

  get target(): number { return this._target; }
  set target(v: number) {
    this._target = v;
  }

  setTarget(v: number): void { this.target = v; }
  retarget(v: number): void { this.target = v; }
  to(v: number): void { this.target = v; }
  set(v: number): void { this.target = v; }

  get settled(): boolean { return this.isSettled(); }
  isSettled(threshold = 1e-3): boolean {
    return (
      Math.abs(this._value - this._target) < threshold &&
      Math.abs(this._velocity) < threshold
    );
  }

  step(dt: number): number {
    if (!Number.isFinite(dt) || dt <= 0) return this._value;
    let seconds = dt > 1 ? dt / 1000 : dt;
    if (seconds > 0.25) seconds = 0.25;
    const maxStep = 1 / 120;
    const steps = Math.max(1, Math.ceil(seconds / maxStep));
    const h = seconds / steps;
    for (let i = 0; i < steps; i += 1) {
      this.integrate(h);
    }
    return this._value;
  }

  update(dt: number): number { return this.step(dt); }
  advance(dt: number): number { return this.step(dt); }
  tick(dt: number): number { return this.step(dt); }

  private integrate(h: number): void {
    const omega = (2 * Math.PI) / this._response;
    const zeta = this._damping;
    const displacement = this._value - this._target;
    const springForce = -omega * omega * displacement;
    const dampingForce = -2 * zeta * omega * this._velocity;
    const acceleration = springForce + dampingForce;
    this._velocity += acceleration * h;
    this._value += this._velocity * h;
  }
}
