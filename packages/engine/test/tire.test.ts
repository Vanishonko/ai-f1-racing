import test from "node:test";
import assert from "node:assert/strict";
import {
  axleNormalLoads,
  DEFAULT_TIRE,
  slipRatio,
  tireBudget,
  tireForces,
} from "../src/tire.ts";

/** Shared F1-ish parameters for the braking experiments. */
const MASS = 798;
const G = 9.81;
const WHEELBASE = 3.6;
const CG_HEIGHT = 0.30;
const WHEEL_RADIUS = 0.33;
const WEIGHT_DIST_FRONT = 0.45;
const WHEEL_INERTIA = 1.1; // includes driveline reflected inertia
const STATIC_FRONT_TIRE = (MASS * G * WEIGHT_DIST_FRONT) / 2;

/** Force produced by one tire at a given slip ratio, free-rolling laterally. */
const fxAt = (slip: number, Fz: number, muLoad = 1): number =>
  tireForces(Fz, slip, 0, muLoad, DEFAULT_TIRE).fx;

test("tire: longitudinal force peaks at the design slip and then falls away", () => {
  const Fz = STATIC_FRONT_TIRE;
  const atPeak = fxAt(-DEFAULT_TIRE.slipRatioPeak, Fz);
  const atFullLock = fxAt(-1, Fz);
  // The budget is load-sensitive, so it is NOT simply mu*Fz. Assert against the
  // same radius the sim clamps to.
  const budget = tireBudget(Fz);

  assert.ok(
    Math.abs(Math.abs(atPeak) - budget) < budget * 1e-3,
    `peak force should reach the friction budget, got ${Math.abs(atPeak)} vs ${budget}`,
  );
  assert.ok(
    Math.abs(atPeak) > DEFAULT_TIRE.muX * Fz * 0.99,
    "the raw peak should still be at least mu*Fz",
  );

  // Past the peak, MORE slip means LESS braking force. This is the property
  // that makes a locked wheel slow you down less than a threshold-braked one.
  //
  // The margin is small (~10%) because a locked racing slick still slides at
  // most of its peak friction. That is realistic, and it is why a lockup is a
  // time loss and a loss of steering rather than a total loss of brakes.
  // Compare MAGNITUDES: braking force is negative in this sign convention, so a
  // bare `<` between the two values would invert the comparison entirely.
  assert.ok(
    Math.abs(atFullLock) < Math.abs(atPeak) * 0.97,
    `full lock must lose force vs the peak: ${Math.abs(atFullLock)} vs ${Math.abs(atPeak)}`,
  );
  // The braking loss at full lock is moderate — a racing slick sliding on asphalt
  // keeps most of its kinetic friction. That is realistic, and it means the real
  // cost of a lockup is not stopping power, it is that you can no longer steer.
  // The lateral-collapse test below is where that shows up.
  const retained = Math.abs(atFullLock) / Math.abs(atPeak);
  assert.ok(
    retained > 0.8 && retained < 0.95,
    `a locked tire should keep 80-95% of peak braking, kept ${(retained * 100).toFixed(1)}%`,
  );

  // The fold-back must be steep enough that slip management is a real skill
  // rather than a matter of opinion. Losing a tenth of grip at double the peak
  // slip is what makes braking at the limit worth learning.
  const overslip = Math.abs(fxAt(-2 * DEFAULT_TIRE.slipRatioPeak, Fz));
  const overslipRetained = overslip / Math.abs(atPeak);
  assert.ok(
    overslipRetained < 0.97,
    `double the peak slip must already cost grip: kept ${(overslipRetained * 100).toFixed(1)}%`,
  );

  // Monotonic increase in braking MAGNITUDE up to the peak. Braking force is
  // negative here, so it must get progressively more negative.
  let previousMagnitude = 0;
  for (let s = 0; s <= DEFAULT_TIRE.slipRatioPeak; s += 0.01) {
    const magnitude = Math.abs(fxAt(-s, Fz));
    assert.ok(
      magnitude >= previousMagnitude - 1e-9,
      `force must build to the peak; dipped at s=${s.toFixed(2)}`,
    );
    previousMagnitude = magnitude;
  }

  // Directional symmetry: spinning a wheel up past the peak also loses force.
  // Compared by magnitude, because the force is negative in both cases and a
  // bare difference would come out as -0 relative to a negative baseline.
  assert.ok(
    Math.abs(Math.abs(fxAt(1, Fz)) - Math.abs(atFullLock)) < Math.abs(atFullLock) * 1e-9,
    "spin and lock must lose the same amount of force",
  );
});

test("tire: no slip produces no longitudinal force", () => {
  assert.equal(fxAt(0, STATIC_FRONT_TIRE), 0);
  assert.equal(fxAt(0, 0), 0);
});

test("tire: sign conventions", () => {
  const Fz = STATIC_FRONT_TIRE;
  assert.ok(fxAt(0.05, Fz) > 0, "positive slip drives the car forward");
  assert.ok(fxAt(-0.05, Fz) < 0, "negative slip brakes the car");
  assert.equal(slipRatio(2 * 10, 10), 1, "wheel at twice road speed is full spin");
  assert.equal(slipRatio(0, 10), -1, "stationary wheel is full lock");
  assert.equal(slipRatio(10, 10), 0, "free rolling");
});

test("tire: the resultant force never exceeds the friction circle", () => {
  // The invariant the whole coupling rests on. If this can be violated, a
  // locked wheel could generate MORE total force than a gripping one, and the
  // sim would actively reward locking up.
  const Fz = STATIC_FRONT_TIRE;
  const budget = tireBudget(Fz);
  const tolerance = budget * 1e-6;

  for (let sr = -1.5; sr <= 1.5; sr += 0.02) {
    for (let sa = -0.5; sa <= 0.5; sa += 0.02) {
      for (const omega of [0, 20, 200]) {
        const f = tireForces(Fz, sr, sa, 1, DEFAULT_TIRE, omega);
        const magnitude = Math.sqrt(f.fx * f.fx + f.fy * f.fy);
        assert.ok(
          magnitude <= budget + tolerance,
          `circle violated at sr=${sr.toFixed(2)} sa=${sa.toFixed(2)}: ` +
            `${magnitude.toFixed(1)} > ${budget.toFixed(1)}`,
        );
      }
    }
  }
});

test("locked fronts: plenty of braking force, but cornering force collapses", () => {
  const Fz = STATIC_FRONT_TIRE;
  const muFz = DEFAULT_TIRE.muX * Fz;
  const slipAngle = DEFAULT_TIRE.slipAnglePeak;

  const rolling = tireForces(Fz, 0, slipAngle, 1, DEFAULT_TIRE, 30);
  const locked = tireForces(Fz, -1.0, slipAngle, 1, DEFAULT_TIRE, 0);

  // The braking channel keeps MOST of its force. A lockup scrubs speed at
  // roughly 80% of the achievable optimum, which is why it feels like "the
  // brakes are on but the car is not stopping and will not turn".
  assert.ok(
    Math.abs(locked.fx) > muFz * 0.7,
    `a locked tire should still brake hard, got ${Math.abs(locked.fx) / muFz}`,
  );

  // The cornering channel does not. This is the "goes straight" behaviour.
  const lateralRetained = Math.abs(locked.fy) / Math.abs(rolling.fy);
  assert.ok(
    lateralRetained < 0.3,
    `locking must cost >70% of lateral force, retained ${lateralRetained.toFixed(3)}`,
  );

  // And the resultant rotates backwards: the tire is now pushing against the
  // car's motion rather than across it, so it cannot yaw the car.
  const rollingAngle = Math.abs(rolling.fy) / Math.abs(rolling.fx + 1e-9);
  const lockedAngle = Math.abs(locked.fy) / Math.abs(locked.fx);
  assert.ok(lockedAngle < rollingAngle, "the force vector must rotate rearwards");
  assert.equal(locked.locked, true, "zero omega at high slip must report locked");
  assert.equal(rolling.locked, false);
});

/**
 * Maximum yaw moment the front and rear axles can produce together, each
 * generating lateral force in the helpful direction.
 *
 * WHY MAX RATHER THAN A STEADY-STATE SUBTRACTION: on any given car the front
 * and rear yaw contributions very nearly cancel, so `front*a - rear*b` sits
 * close to zero and its sign is a question of car setup rather than of tire
 * behaviour. The maximum-available-yaw metric is the useful one, because it
 * measures the total steering authority in the car, which is what a driver
 * actually spends.
 */
const maxYawMoment = (
  frontFz: number,
  rearFz: number,
  frontSlipAngle: number,
  rearSlipAngle: number,
  a: number,
  b: number,
  frontLocked: boolean,
  rearLocked: boolean,
): number => {
  const front = tireForces(frontFz, frontLocked ? -1 : 0, frontSlipAngle, 1, DEFAULT_TIRE, frontLocked ? 0 : 30);
  const rear = tireForces(rearFz, rearLocked ? -1 : 0, rearSlipAngle, 1, DEFAULT_TIRE, rearLocked ? 0 : 30);
  // Two tires per axle; both are asked for force in the same helpful direction.
  return 2 * (Math.abs(front.fy) * a + Math.abs(rear.fy) * b);
};

/**
 * Share of available yaw authority coming from the FRONT axle, 0..1.
 *
 * This is the balance metric, and it is what understeer and oversteer actually
 * mean: a car with a high front share resists rotation and understeers; a car
 * whose rear share has grown will rotate.
 *
 * Note it is deliberately a SHARE, not an absolute force. A locked rear does not
 * produce more force than a gripping one — it produces LESS. The car steps out
 * because the rear's share of grip collapses, not because the rear suddenly
 * generates extra yaw force. Asserting an absolute increase would be wrong.
 */
const frontYawShare = (
  frontFz: number,
  rearFz: number,
  slipAngle: number,
  a: number,
  b: number,
  frontLocked: boolean,
  rearLocked: boolean,
): number => {
  const front = Math.abs(
    tireForces(frontFz, frontLocked ? -1 : 0, slipAngle, 1, DEFAULT_TIRE, frontLocked ? 0 : 30).fy,
  );
  const rear = Math.abs(
    tireForces(rearFz, rearLocked ? -1 : 0, slipAngle, 1, DEFAULT_TIRE, rearLocked ? 0 : 30).fy,
  );
  const frontContribution = front * a;
  const rearContribution = rear * b;
  return frontContribution / (frontContribution + rearContribution);
};

test("locked fronts lose steering authority and more lock cannot recover it", () => {
  // Vehicle-level, not just a single tire: the yaw moment available to the
  // driver is what actually determines whether the car turns.
  const a = WHEELBASE * (1 - WEIGHT_DIST_FRONT);
  const b = WHEELBASE * WEIGHT_DIST_FRONT;
  const loads = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, 0);
  const frontFz = loads.front / 2;
  const rearFz = loads.rear / 2;

  // Best case for the locked front is at the slip peak, so that is where the
  // loss is largest and where we assert it.
  const gripYaw = maxYawMoment(frontFz, rearFz, 0.11, 0.12, a, b, false, false);
  const lockedYaw = maxYawMoment(frontFz, rearFz, 0.11, 0.12, a, b, true, false);

  assert.ok(gripYaw > 0, "a gripping car must have yaw authority");
  assert.ok(
    lockedYaw < gripYaw * 0.7,
    `locked fronts must lose a lot of yaw authority: ${lockedYaw.toFixed(0)} vs ${gripYaw.toFixed(0)}`,
  );

  /**
   * Winding on MORE steering lock does not rescue it.
   *
   * Worth being precise, because the naive expectation is wrong in an
   * interesting way: locked yaw authority does creep back up as slip angle
   * grows (a tire sliding sideways at a bigger angle still makes some lateral
   * force by kinetic friction), but it never returns to gripping levels. So the
   * assertion is not "more lock makes it worse" — it is "more lock cannot fix
   * it", which is the property a driver actually feels.
   */
  const gripYawMoreLock = maxYawMoment(frontFz, rearFz, 0.30, 0.12, a, b, false, false);
  const lockedYawMoreLock = maxYawMoment(frontFz, rearFz, 0.30, 0.12, a, b, true, false);

  assert.ok(
    lockedYawMoreLock < lockedYaw * 1.25,
    "more lock must not restore significant yaw authority",
  );
  assert.ok(
    lockedYawMoreLock < gripYawMoreLock * 0.75,
    `a locked front cannot be steered out of: ${lockedYawMoreLock.toFixed(0)} ` +
      `vs ${gripYawMoreLock.toFixed(0)} gripping`,
  );

  // Sanity on the starting point: at the slip peak a gripping front is already
  // near its maximum, so the locked car is losing real authority right where it
  // most wants it.
  assert.ok(
    gripYaw > lockedYaw * 1.5,
    "a gripping front must have far more authority than a locked one",
  );
});

test("locked fronts shift balance to understeer, locked rears to oversteer", () => {
  // The balance test. Front lateral force dropping makes the car understeer;
  // rear lateral force dropping makes it oversteer. Both fall out of the same
  // equations with no per-case special handling.
  const slipAngle = 0.15;
  const a = WHEELBASE * (1 - WEIGHT_DIST_FRONT);
  const b = WHEELBASE * WEIGHT_DIST_FRONT;
  const loads = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, 0);
  const frontFz = loads.front / 2;
  const rearFz = loads.rear / 2;

  const clean = frontYawShare(frontFz, rearFz, slipAngle, a, b, false, false);
  const frontLocked = frontYawShare(frontFz, rearFz, slipAngle, a, b, true, false);
  const rearLocked = frontYawShare(frontFz, rearFz, slipAngle, a, b, false, true);

  assert.ok(
    frontLocked < clean,
    `locking the fronts must shift balance toward understeer: ${frontLocked.toFixed(3)} ` +
      `vs ${clean.toFixed(3)}`,
  );
  assert.ok(
    rearLocked > clean,
    `locking the rears must shift balance toward oversteer: ${rearLocked.toFixed(3)} ` +
      `vs ${clean.toFixed(3)}`,
  );

  // The understeer shift must be substantial, not a rounding artifact.
  assert.ok(
    frontLocked < clean * 0.9,
    `the understeer shift must be meaningful: ${frontLocked.toFixed(3)} vs ${clean.toFixed(3)}`,
  );
});


test("load transfer: braking moves weight onto the front axle", () => {
  const staticLoads = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, 0);
  assert.ok(
    Math.abs(staticLoads.front + staticLoads.rear - MASS * G) < 1e-6,
    "loads must sum to total weight",
  );
  assert.ok(
    Math.abs(staticLoads.front - MASS * G * WEIGHT_DIST_FRONT) < 1e-6,
    "at rest the split is exactly the static distribution",
  );

  const braking = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, -3 * G);
  assert.ok(braking.front > staticLoads.front, "front load must rise under braking");
  assert.ok(braking.rear < staticLoads.rear, "rear load must fall under braking");
  assert.ok(
    Math.abs(braking.front + braking.rear - MASS * G) < 1e-6,
    "load transfer moves weight, it does not create it",
  );

  const accelerating = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, 1.5 * G);
  assert.ok(accelerating.rear > staticLoads.rear, "rear must squat under power");
  assert.ok(accelerating.front < staticLoads.front, "front must go light under power");

  // Weight can be transferred off an axle entirely, but never negative.
  const extreme = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, -20 * G);
  assert.equal(extreme.rear, 0, "an unloaded axle carries no load, not negative");
  assert.ok(extreme.front > 0, "the loaded axle carries everything");
});

test("fronts are the more oversubscribed axle under braking with forward bias", () => {
  // Load transfer loads the front, so at a fixed brake torque the front tire
  // has MORE grip available than the rear. Front lockup is therefore not about
  // grip capacity — it is about how much torque each axle is asked for.
  const decel = -3 * G;
  const loads = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, decel);
  const frontCapacity = DEFAULT_TIRE.muX * (loads.front / 2) * WHEEL_RADIUS;
  const rearCapacity = DEFAULT_TIRE.muX * (loads.rear / 2) * WHEEL_RADIUS;

  assert.ok(
    frontCapacity > rearCapacity,
    "the loaded front tire must have more grip capacity than the unloaded rear",
  );

  // The front therefore needs MORE absolute torque to lock. Front lockup is
  // still the default because forward brake bias gives it a bigger share of a
  // demand both axles are asked for — the bias has to exceed the capacity
  // ratio, which is exactly what real cars do.
  const capacityRatio = frontCapacity / (frontCapacity + rearCapacity);
  const brakeBiasFront = capacityRatio + 0.10;
  const totalTorque = 2 * frontCapacity * 1.35;
  const frontDemand = (totalTorque * brakeBiasFront) / 2;
  const rearDemand = (totalTorque * (1 - brakeBiasFront)) / 2;

  assert.ok(
    brakeBiasFront > capacityRatio,
    "bias must be frontward of the capacity ratio for the fronts to lock first",
  );
  assert.ok(
    frontDemand > frontCapacity,
    `the front must exceed its grip capacity: ${frontDemand.toFixed(0)} > ${frontCapacity.toFixed(0)}`,
  );
  assert.ok(
    rearDemand < rearCapacity,
    `the rear must stay within its capacity: ${rearDemand.toFixed(0)} < ${rearCapacity.toFixed(0)}`,
  );
});

test("rearward brake bias locks the rears instead, and the car steps out", () => {
  const decel = -3 * G;
  const loads = axleNormalLoads(MASS, G, WEIGHT_DIST_FRONT, WHEELBASE, CG_HEIGHT, decel);
  const frontCapacity = DEFAULT_TIRE.muX * (loads.front / 2) * WHEEL_RADIUS;
  const rearCapacity = DEFAULT_TIRE.muX * (loads.rear / 2) * WHEEL_RADIUS;

  const brakeBiasFront = 0.30;
  const totalTorque = 2 * frontCapacity * 1.35;
  const frontDemand = (totalTorque * brakeBiasFront) / 2;
  const rearDemand = (totalTorque * (1 - brakeBiasFront)) / 2;

  assert.ok(rearDemand > rearCapacity, "rearward bias must oversubscribe the rear");
  assert.ok(frontDemand < frontCapacity, "and leave the front still gripping");
});

test("a locked wheel brakes measurably worse than one at the slip peak", () => {
  // The reason brake pressure must be a real, analog decision. A driver who
  // simply applies maximum pressure loses longitudinal force versus one who
  // holds the tire at its slip peak, because past the peak more slip means
  // LESS force. This is a force-space property; vehicle-level stopping
  // distance follows from it through the car model.
  const Fz = STATIC_FRONT_TIRE;
  const peak = Math.abs(fxAt(-DEFAULT_TIRE.slipRatioPeak, Fz));
  const locked = Math.abs(fxAt(-1, Fz));

  assert.ok(
    locked < peak * (1 - 1e-4),
    `full lock must produce less longitudinal force than the peak: ${locked} vs ${peak}`,
  );

  // ...but not catastrophically less. A lockup is a time loss and a loss of
  // steering, not an instant retirement. That matters for how much the reward
  // function should punish a lockup event, so it is pinned down here.
  const retained = locked / peak;
  assert.ok(retained > 0.8, `a locked tire keeps most sliding friction: ${retained}`);
  assert.ok(retained < 1, "but never more than the peak");
});


