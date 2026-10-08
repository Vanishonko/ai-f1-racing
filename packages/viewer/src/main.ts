/**
 * Drivable viewer: renders the deterministic sim and lets you drive it.
 *
 * The physics here is THE SAME code the trainer will run. Nothing is forked or
 * simplified for display, so what you feel in this page is what the evolutionary
 * search will be optimising against. That is only possible because the engine has
 * no DOM or I/O dependencies and is bit-deterministic.
 *
 * Imports use relative paths so the typechecker can resolve them, but the build
 * rewrites each specifier to `/engine/*.js` for the browser. Keeping the source
 * importable by `tsc` matters: without it the viewer would be unchecked
 * JavaScript and a typo here would only show up as a blank canvas.
 */

import {
  CLEAN_AIR,
  createCarState,
  DEFAULT_CAR_PARAMS,
  stepCar,
  WHEEL_FL,
  WHEEL_FR,
  WHEEL_RL,
  WHEEL_RR,
  type CarState,
  type StepContext,
} from "../../engine/src/car.ts";
import { buildHandTrack } from "../../engine/src/trackLibrary.ts";
import { projectToTrack, pointAtDistance, type Track } from "../../engine/src/track.ts";
import { gripNoiseAt } from "../../engine/src/rng.ts";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const track: Track = buildHandTrack("club")!;
const car: CarState = createCarState();
const params = DEFAULT_CAR_PARAMS;
const stepContext: StepContext = { ...CLEAN_AIR };

const DT = 1 / 60;
const TRAIL_LENGTH = 220;
const trail: Array<{ x: number; y: number }> = [];

/** Keys currently held, so throttle and steering can ramp like real inputs. */
const held = new Set<string>();

const resetToStart = (): void => {
  const point = pointAtDistance(track, 0);
  car.x = point.x;
  car.y = point.y;
  car.heading = Math.atan2(point.ty, point.tx);
  car.vx = 0;
  car.vy = 0;
  car.yawRate = 0;
  car.omega.fill(0);
  car.steerAngle = 0;
  car.steerCommand = 0;
  car.throttle = 0;
  car.brake = 0;
  car.gear = 0;
  car.rpm = params.engine.idleRpm;
  car.wear.fill(0);
  car.frontLockTime = 0;
  car.wheelspinTime = 0;
  car.saturatedTime = 0;
  car.distance = 0;
  trail.length = 0;
};

resetToStart();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (event: KeyboardEvent) => {
  held.add(event.key.toLowerCase());
  if (event.key === " ") event.preventDefault();
  if (event.key.toLowerCase() === "r") resetToStart();
});
window.addEventListener("keyup", (event: KeyboardEvent) => held.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => held.clear());

const readInputs = (): void => {
  const wantsThrottle = held.has("w") || held.has("arrowup");
  const wantsBrake = held.has("s") || held.has("arrowdown") || held.has(" ");
  const wantsLeft = held.has("a") || held.has("arrowleft");
  const wantsRight = held.has("d") || held.has("arrowright");

  // Ramp the pedals and the wheel rather than snapping them, so the driver's
  // inputs are analog in the same way the eventual AI's outputs will be.
  const pedalRate = 4.5 / 60;
  const steerRate = 3.2 / 60;

  car.throttle = clamp01(car.throttle + (wantsThrottle ? pedalRate : -pedalRate * 1.6));
  car.brake = clamp01(car.brake + (wantsBrake ? pedalRate * 1.3 : -pedalRate * 2.0));

  /*
   * `steerCommand = -1` turns the car RIGHT and `+1` turns it LEFT. That is the
   * opposite of what the sign looks like it should mean, and it is worth stating
   * plainly because it was got wrong twice.
   *
   * The engine's convention was verified by driving the page and reading the
   * heading: a negative command produces a NEGATIVE heading change, and a negative
   * canvas rotation is clockwise, which on screen is a right turn. The engine test
   * pins the same mapping from the physics side.
   */
  const targetSteer = wantsLeft ? 1 : wantsRight ? -1 : 0;
  const delta = targetSteer - car.steerCommand;
  car.steerCommand += Math.abs(delta) < steerRate ? delta : Math.sign(delta) * steerRate;

  // Q halves brake pressure: the difference between stamping on the pedal and
  // braking at the limit is the whole point of the tire model, so it needs a key.
  stepContext.brakeScale = held.has("q") ? 0.5 : 1;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// Tire smoke
// ---------------------------------------------------------------------------
/**
 * Deliberately crude smoke, and deliberately NOT in the engine.
 *
 * Emitted when a tire is sliding — locked or spinning hard — and stored as a flat
 * ring buffer so nothing allocates per frame. It is a visual aid for seeing where
 * the limit is, not a fluid simulation, so it is a handful of fading discs.
 *
 * Keeping it out of `packages/engine` matters: particles are a rendering concern
 * with a random element, and the engine's determinism is what makes replays
 * reproducible from a seed. A cosmetic effect must never be able to break that, so
 * the engine has no idea this exists.
 */
const SMOKE_MAX = 160;
const smoke = {
  x: new Float64Array(SMOKE_MAX),
  y: new Float64Array(SMOKE_MAX),
  age: new Float64Array(SMOKE_MAX),
  life: new Float64Array(SMOKE_MAX),
  size: new Float64Array(SMOKE_MAX),
  count: 0,
  write: 0,
  // Emission is throttled so a long slide does not empty the whole pool at once.
  cooldown: 0,
};

const emitSmoke = (x: number, y: number, intensity: number): void => {
  const index = smoke.write;
  smoke.x[index] = x;
  smoke.y[index] = y;
  smoke.age[index] = 0;
  smoke.life[index] = 0.55 + 0.35 * ((index * 37) % 100) / 100;
  smoke.size[index] = 1.6 + 2.6 * intensity;
  smoke.write = (index + 1) % SMOKE_MAX;
  if (smoke.count < SMOKE_MAX) smoke.count++;
};

const updateSmoke = (dt: number): void => {
  smoke.cooldown -= dt;
  const wantsSmoke = (document.getElementById("smoke") as HTMLInputElement | null)?.checked ?? false;
  if (!wantsSmoke) { smoke.count = 0; return; }

  // Which tires are sliding, and how hard.
  const offsets: Array<[number, number]> = [
    [params.cgToFront, params.trackFront / 2],
    [params.cgToFront, -params.trackFront / 2],
    [-params.cgToRear, params.trackRear / 2],
    [-params.cgToRear, -params.trackRear / 2],
  ];

  const reference = Math.max(Math.abs(car.vx), 2);
  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);

  for (let w = 0; w < 4; w++) {
    const slip = Math.abs((car.omega[w]! * params.wheelRadius - car.vx) / reference);
    // Only well past the grip peak makes smoke, so it reads as a warning rather
    // than as constant haze.
    if (slip < 0.45) continue;
    const intensity = Math.min(1, (slip - 0.45) / 0.9);
    if (smoke.cooldown > 0) continue;
    const [forward, lateral] = offsets[w]!;
    emitSmoke(
      car.x + forward * cos - lateral * sin,
      car.y + forward * sin + lateral * cos,
      intensity,
    );
  }
  if (smoke.cooldown <= 0) smoke.cooldown = 0.012;

  for (let i = 0; i < smoke.count; i++) smoke.age[i]! += dt;
};

const drawSmoke = (): void => {
  const wantsSmoke = (document.getElementById("smoke") as HTMLInputElement | null)?.checked ?? false;
  if (!wantsSmoke) return;

  for (let i = 0; i < smoke.count; i++) {
    const t = smoke.age[i]! / smoke.life[i]!;
    if (t >= 1) continue;
    const radius = smoke.size[i]! * (0.6 + t * 2.4) * camera.scale * 0.5;
    const alpha = (1 - t) * 0.35;
    ctx.beginPath();
    ctx.arc(toScreenX(smoke.x[i]!), toScreenY(smoke.y[i]!), Math.max(1, radius), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(214,220,228,${alpha.toFixed(3)})`;
    ctx.fill();
  }
};

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
let camera = { x: 0, y: 0, scale: 1 };
const followToggle = document.getElementById("follow") as HTMLInputElement;

const updateCamera = (): void => {
  const canvasAspect = canvas.width / canvas.height;
  const margin = 1.25;

  if (followToggle.checked) {
    // Chase camera: locked to the car, zoomed in enough to see the tires work.
    camera.scale = Math.min(canvas.width, canvas.height) / 90;
    camera.x = car.x;
    camera.y = car.y;
  } else {
    // Fit the whole circuit.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < track.xs.length; i++) {
      if (track.xs[i]! < minX) minX = track.xs[i]!;
      if (track.xs[i]! > maxX) maxX = track.xs[i]!;
      if (track.ys[i]! < minY) minY = track.ys[i]!;
      if (track.ys[i]! > maxY) maxY = track.ys[i]!;
    }
    const spanX = (maxX - minX) * margin;
    const spanY = (maxY - minY) * margin;
    camera.scale = Math.min(canvas.width / spanX, canvas.height / (spanY * canvasAspect) * canvasAspect);
    camera.scale = Math.min(canvas.width / spanX, canvas.height / spanY);
    camera.x = (minX + maxX) / 2;
    camera.y = (minY + maxY) / 2;
  }
};

const toScreenX = (x: number): number => (x - camera.x) * camera.scale + canvas.width / 2;
const toScreenY = (y: number): number => canvas.height / 2 - (y - camera.y) * camera.scale;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const REDRAW = {
  asphalt: "#2a2f36",
  kerb: "#4a5058",
  line: "#6f7883",
  grass: "#101512",
  sky: "#0b0d10",
};

const drawTrack = (): void => {
  const width = track.halfWidth * camera.scale;

  // Track surface: one stroked path along the centreline. Cheaper and smoother
  // than filling a mesh, and it scales cleanly with the camera.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.strokeStyle = REDRAW.grass;
  ctx.lineWidth = width * 2 + Math.max(6, 4 * camera.scale);
  strokeCentreline();

  ctx.strokeStyle = REDRAW.asphalt;
  ctx.lineWidth = width * 2;
  strokeCentreline();

  // Kerbs: narrow strokes just inside the edge.
  ctx.strokeStyle = REDRAW.kerb;
  ctx.lineWidth = Math.max(1, 1.1 * camera.scale);
  ctx.setLineDash([6, 6]);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i < track.xs.length; i++) {
      const nx = -track.ty[i]! * track.halfWidth * side;
      const ny = track.tx[i]! * track.halfWidth * side;
      const sx = toScreenX(track.xs[i]! + nx);
      const sy = toScreenY(track.ys[i]! + ny);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Start / finish.
  const start = pointAtDistance(track, 0);
  const nx = -start.ty * track.halfWidth;
  const ny = start.tx * track.halfWidth;
  ctx.strokeStyle = "#e6edf3";
  ctx.lineWidth = Math.max(2, 0.5 * camera.scale);
  ctx.beginPath();
  ctx.moveTo(toScreenX(start.x + nx), toScreenY(start.y + ny));
  ctx.lineTo(toScreenX(start.x - nx), toScreenY(start.y - ny));
  ctx.stroke();
};

const strokeCentreline = (): void => {
  ctx.beginPath();
  for (let i = 0; i < track.xs.length; i++) {
    const sx = toScreenX(track.xs[i]!);
    const sy = toScreenY(track.ys[i]!);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  ctx.stroke();
};

const drawTrail = (): void => {
  if (trail.length < 2) return;
  ctx.lineWidth = Math.max(1, 0.16 * camera.scale);
  for (let i = 1; i < trail.length; i++) {
    const alpha = i / trail.length;
    ctx.strokeStyle = `rgba(91,157,255,${(alpha * 0.5).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(toScreenX(trail[i - 1]!.x), toScreenY(trail[i - 1]!.y));
    ctx.lineTo(toScreenX(trail[i]!.x), toScreenY(trail[i]!.y));
    ctx.stroke();
  }
};

const drawWheelForces = (): void => {
  const scale = camera.scale * 0.02;
  const offsets: Array<[number, number]> = [
    [params.cgToFront, params.trackFront / 2],
    [params.cgToFront, -params.trackFront / 2],
    [-params.cgToRear, params.trackRear / 2],
    [-params.cgToRear, -params.trackRear / 2],
  ];

  const cos = Math.cos(car.heading);
  const sin = Math.sin(car.heading);

  for (let w = 0; w < 4; w++) {
    const [forward, lateral] = offsets[w]!;
    // Body frame to world: forward along heading, lateral to the left.
    const wx = car.x + forward * cos - lateral * sin;
    const wy = car.y + forward * sin + lateral * cos;

    const load = car.normalLoad[w]!;
    const used = car.utilization[w]!;

    // A ring sized by load and coloured by how much of the friction circle is
    // spent. This is the overlay that makes lockup visible: the ring goes red and
    // the tire stops producing the force the driver is asking for.
    const radius = Math.max(3, Math.sqrt(load) * 0.055 * camera.scale);
    ctx.beginPath();
    ctx.arc(toScreenX(wx), toScreenY(wy), radius, 0, Math.PI * 2);
    ctx.strokeStyle = used > 0.99 ? "#ff3b30" : used > 0.9 ? "#ffb340" : "#3ddc84";
    ctx.lineWidth = Math.max(1.5, 0.3 * camera.scale);
    ctx.stroke();

    if (car.saturated[w] === 1) {
      ctx.fillStyle = "rgba(255,59,48,0.22)";
      ctx.fill();
    }
  }
};

const drawCar = (): void => {
  const bodyLength = (params.cgToFront + params.cgToRear) * camera.scale;
  const bodyWidth = params.trackFront * camera.scale;

  ctx.save();
  ctx.translate(toScreenX(car.x), toScreenY(car.y));
  ctx.rotate(-car.heading);

  // Chassis.
  ctx.fillStyle = "#ff3b30";
  ctx.beginPath();
  ctx.roundRect(-bodyLength * 0.46, -bodyWidth / 2, bodyLength, bodyWidth, Math.max(2, bodyWidth * 0.22));
  ctx.fill();

  // Nose, so orientation is readable at a glance.
  ctx.fillStyle = "#ffd0cd";
  ctx.beginPath();
  ctx.roundRect(bodyLength * 0.18, -bodyWidth * 0.32, bodyLength * 0.28, bodyWidth * 0.64, 2);
  ctx.fill();

  // Wheels, drawn at their actual steering angle.
  ctx.fillStyle = "#0b0d10";
  const wheelLength = 0.62 * bodyWidth;
  const wheelWidth = 0.32 * bodyWidth;
  const corners: Array<[number, number, boolean]> = [
    [params.cgToFront, params.trackFront / 2, true],
    [params.cgToFront, -params.trackFront / 2, true],
    [-params.cgToRear, params.trackRear / 2, false],
    [-params.cgToRear, -params.trackRear / 2, false],
  ];
  for (const [forward, lateral, steers] of corners) {
    ctx.save();
    ctx.translate(forward * camera.scale, -lateral * camera.scale);
    // Screen Y is flipped relative to the world's, so a wheel turned by
    // +steerAngle in the car's frame draws at -steerAngle here.
    if (steers) ctx.rotate(-car.steerAngle);
    ctx.fillRect(-wheelLength / 2, -wheelWidth / 2, wheelLength, wheelWidth);
    ctx.restore();
  }

  ctx.restore();
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
const text = (id: string, value: string): void => {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
};
const bar = (id: string, value: number): void => {
  const node = document.getElementById(id) as HTMLElement | null;
  if (node) node.style.width = `${Math.round(clamp01(value) * 100)}%`;
};

const updatePanel = (): void => {
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy) * 3.6;
  text("speed", speed.toFixed(0));
  text("gear", String(car.gear + 1));
  text("rpm", car.rpm.toFixed(0));
  text("thr-pct", `${Math.round(car.throttle * 100)}%`);
  text("brk-pct", `${Math.round(car.brake * 100)}%`);
  text("str-val", car.steerAngle.toFixed(2));
  bar("thr", car.throttle);
  bar("brk", car.brake);
  // The bar fills rightward for a RIGHT turn, and the indicator is inverted
  // because a positive steering angle is a left turn.
  bar("str", (-car.steerAngle / 0.55 + 1) / 2);

  const frontLoad = car.normalLoad[WHEEL_FL]! + car.normalLoad[WHEEL_FR]!;
  const rearLoad = car.normalLoad[WHEEL_RL]! + car.normalLoad[WHEEL_RR]!;
  const total = frontLoad + rearLoad;
  text("load", `${((frontLoad / total) * 100).toFixed(0)}% / ${((rearLoad / total) * 100).toFixed(0)}%`);

  const frontUse = Math.max(car.utilization[WHEEL_FL]!, car.utilization[WHEEL_FR]!);
  const rearUse = Math.max(car.utilization[WHEEL_RL]!, car.utilization[WHEEL_RR]!);
  text("grip", `${frontUse.toFixed(2)} / ${rearUse.toFixed(2)}`);

  const lockNode = document.getElementById("lock");
  if (lockNode) {
    lockNode.textContent = `${car.frontLockTime.toFixed(2)} s`;
    lockNode.style.color = car.frontLockTime > 0.4 ? "#ff3b30" : "";
  }
  const spinNode = document.getElementById("spin");
  if (spinNode) {
    spinNode.textContent = `${car.wheelspinTime.toFixed(2)} s`;
    spinNode.style.color = car.wheelspinTime > 0.4 ? "#ffb340" : "";
  }

  const wear = (car.wear[0]! + car.wear[1]! + car.wear[2]! + car.wear[3]!) / 4;
  text("wear", `${(wear * 100).toFixed(1)}%`);

  const projection = projectToTrack(track, car.x, car.y);
  const onTrackNode = document.getElementById("rpm");
  void onTrackNode;
  // Off-track warning: the car is outside the drivable width.
  document.body.style.setProperty("--accent", projection.onTrack ? "#ff3b30" : "#ffb340");
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const resize = (): void => {
  const rect = canvas.parentElement!.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
};
window.addEventListener("resize", resize);
resize();

/**
 * The live sim state, exposed for measurement.
 *
 * This is not just a convenience: steering direction is the one property that no
 * engine test can check, because every force, moment and load transfer can be
 * self-consistent while the car turns the wrong way. Being able to read the
 * actual heading and position out of a running page is how the convention gets
 * verified end to end.
 */
(window as unknown as { sim: unknown }).sim = { car, track, params, stepContext, resetToStart, held };

let accumulator = 0;
let lastTime = performance.now();

const frame = (now: number): void => {
  // Fixed-step simulation with an accumulator, so the physics runs at exactly
  // 60 Hz regardless of display refresh rate. A 120 Hz monitor must not change
  // the result, or the trainer and the viewer would disagree.
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;
  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= DT && steps < 8) {
    readInputs();
    stepContext.gripNoise = gripNoiseAt(car.distance, track.length);
    stepCar(car, params, DT, stepContext);
    accumulator -= DT;
    steps++;
  }

  // Emission is driven from the current car state once per frame rather than per
  // physics step, so the pool lasts longer and the effect does not depend on how
  // many substeps the loop happened to run.
  updateSmoke(elapsed);

  trail.push({ x: car.x, y: car.y });
  if (trail.length > TRAIL_LENGTH) trail.shift();

  updateCamera();
  ctx.fillStyle = REDRAW.sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTrack();
  drawTrail();
  drawSmoke();
  if ((document.getElementById("rays") as HTMLInputElement).checked) drawWheelForces();
  if ((document.getElementById("ghost") as HTMLInputElement).checked) drawWheelForces();
  drawCar();
  updatePanel();

  requestAnimationFrame(frame);
};

requestAnimationFrame(frame);
