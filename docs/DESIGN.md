# Design

Why this simulator is built the way it is. The short version: most of the
non-obvious decisions exist to stop the evolutionary trainer from converging on
behaviour that looks fine in a graph but is boring to watch.

## The problem being solved

Train AI drivers that race each other on **arbitrary** tracks — not one memorised
layout — with real wheel-to-wheel racing: late-race lunges, defending, and the
willingness to risk a win. Ten cars on a top-down track, continuous throttle and
brake, and a two-day unattended training run.

Four things make that hard, and each shapes the design.

## 1. Track transfer is a sensor-contract problem, not a learning problem

The usual reason a Code Bullet-style car cannot drive a second track is that its
network was wired to a fixed count of raycasts matching one layout. Nothing about
the learning was wrong; the interface was.

So the observation is **egocentric and normalized by track statistics**:

- 15 raycasts over ±135°, normalized by max ray length
- own state: speed, throttle, brake, steer, yaw rate, lateral offset
- driving-line curvature sampled 12× ahead and 12× behind
- race state: elapsed fraction, rank, fuel, tire wear
- **3 rival slots**, presence-masked

No absolute coordinates. No track identifier. No field-size dependency. A genome
trained on 16 tracks drives the 17th without retraining, because `dx = -3 m` means
the same thing everywhere.

## 2. Rival slots must be stable, not nearest

Feeding the network "the 2 closest cars" looks natural and destroys learning:
during an overtake two cars swap distance rank, and the input vector jumps
discontinuously at exactly the moment the policy matters most.

Slots are therefore assigned by **signed track progress** — one rival ahead, one
behind, one nearest-any. These stay continuous through a pass and keep the same
identity for the duration of an overtake. A mask bit indicates an empty slot, so
one car and ten cars use the same layout and 1v1 training transfers to a pack.

## 3. Reward shaping decides whether they fight or follow

The failure mode is a population of tidy drivers who never attempt a pass, because
every pass carries crash risk and a safe fifth place pays better.

Note the shape of the trap: progress-per-tick alone pays a car to crawl forever,
and a large wall penalty alone pays a car to avoid all contact. Both are individually
reasonable. Together they produce a sim that is technically working and no fun.

Countermeasures:

- **Phased reward.** Phase 0 teaches driving with no racecraft terms at all.
  Later phases ramp `raceWeight` until finishing position dominates.
- **Context-gated racecraft bonuses.** A lunge only pays if it yields a position
  gain, and a clean late-race pass is worth more than an early one. This is the
  mechanism behind "chasing the win."
- **Contact is penalised, but not so hard it lobotomises overtaking.** That single
  knob is the difference between a fight and a procession, so it is a named,
  deliberately tuned parameter rather than an incidental one.
- **A crawler baseline in the test suite.** A hand-coded driver that crawls and a
  wall-hugger must never outrank a competent one. Without this test, degenerate
  fitness is discovered two days into a training run.

## 4. Determinism is what makes the whole thing affordable

Fixed 60 Hz step, seeded PRNG, and **no transcendentals in the sim core**:
`sin/cos/exp/pow/hypot` are not guaranteed bit-identical across engines, so
trigonometry is baked into lookup tables at track load and interpolated linearly.
`scripts/lint-determinism.ts` enforces this, and it strips comments first so the
documentation may discuss the banned functions by name.

Determinism buys three things at once:

- Replays reproduce exactly from `(seed, genomeHash)`, so a checkpoint is
  kilobytes and a recorded race is a few megabytes of keyframes.
- The trainer and the viewer run **the same engine**, so what you watch is exactly
  what was learned — no drift between two implementations.
- Divergence bugs surface as a failing hash instead of as mysterious slow decline.

## 5. The tire model is where the racing comes from

Throttle and brake are continuous, and they drive a wheel-level model. What
matters is not realism for its own sake but that **lockup and wheelspin exist and
cost you something**, because that is the skill the AI has to learn.

Three properties are load-bearing.

**Longitudinal force peaks at moderate slip and then falls.** A locked wheel
brakes at roughly 88% of the optimum, so brake pressure is a real analog
decision: a driver who simply applies maximum pressure loses time.

**Longitudinal and lateral demand share one friction budget per tire.** This is
the mechanism behind the single most important behaviour in the sim:

```
                               fx      fy     |F|
rolling, at lateral peak     0.000  -0.991   0.991    <- no braking, full cornering
LOCKED, at lateral peak     -0.876  -0.094   0.881    <- brakes hard, cannot turn
```

A locked front gives up ~90% of its cornering force while keeping most of its
braking force. The resultant no longer points across the car, so it cannot yaw it,
and the car ploughs straight on regardless of steering input. Nothing in the code
special-cases lockup; it falls out of the budget being shared.

**Which axle locks first is emergent, from load transfer.** Braking transfers load
off the rear and onto the front, so with forward brake bias the front is asked for
a larger share of torque than its grip can support and saturates first. Rearward
bias locks the rears instead, and then it is the *rear* that goes lateral-dead and
the car steps out. Both come from the same equations.

### The bug this section exists to prevent

An earlier version composed the two force channels in **slip** space and scaled
the demand vector into the friction circle:

```ts
// WRONG — do not reintroduce
const scale = demandMagnitude > budget ? budget / demandMagnitude : 1;
```

Because the fold-back curve drives a channel's demand far past the budget once
slip is beyond its peak, this normalising scale grows with slip and **exactly
cancels the fold-back**. A fully locked wheel produced precisely the same braking
force as a perfectly threshold-braked one — the simulation rewarded locking up.

Two fixes were needed, and the second only became clear after the first failed:

1. One bounded saturation factor from combined slip, shared by both channels.
2. Force **magnitude** and **direction** computed separately. Magnitude comes from
   a single bounded fold-back curve; direction is a unit vector. The resultant is
   then inside the circle by construction, with **no clamp** — and a clamp is
   precisely what must be avoided, since `min(magnitude, budget)` would reintroduce
   the same cancellation.

`tire.test.ts` pins the numeric sweep (worst resultant/budget ratio must be exactly
1.0) so this cannot come back silently.

## 6. Where the AI is not

No pathfinding or racing-line planner exists anywhere. The network sees curvature
ahead and the position of its rivals, and chooses pedal and wheel. A good line is
something it has to learn, and the reward function does not mention one.

## Open questions

- **Training race length.** Short races iterate faster but may not teach late-race
  aggression, since fuel and tire phase never develop. Full-distance races are
  available for showcase; the mix is a tuning parameter.
- **At what point is `raceWeight` too high?** Measured by the M6 gate, not assumed.
