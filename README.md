# ai-f1

Top-down Formula 1 racing AI. Cars with analog throttle, brake and steering, evolved to race
wheel to wheel on real circuits.

**Status: the environment and the trainer work; the racing does not exist yet.** A single driver
can be trained to lap a circuit. Cars cannot see each other, cannot collide, and there is no
race. See [Where this is going](#where-this-is-going).

---

## Quick start

```bash
npm install --cache .npm-cache     # the global npm cache may not be writable

pnpm test                          # 66 tests
pnpm run check                     # typecheck + determinism lint + tests
pnpm run drive                     # build the viewer and serve it on :4321
pnpm run train -- --hours 13       # train a driver, checkpointing as it goes
```

Open <http://127.0.0.1:4321>, pick a circuit, and drive with `WASD`. Tick **trained driver** to
hand over to a checkpoint once one exists.

---

## What is here

### The simulation

Deterministic 2D physics at a fixed 60 Hz step, in `packages/engine/src`:

| module | what it does |
|---|---|
| `tire.ts` | Slip-based tire model with a friction circle, load sensitivity and a demand curve |
| `car.ts` | Four wheels, weight transfer in both axes, differential, brake bias |
| `powertrain.ts` | Torque curve, rev limiter, shift schedule, clutch |
| `track.ts` | Circuit sampling, projection, corner radii, self-intersection detection |
| `timing.ts` | Lap and sector timing with session-best tracking |

**Determinism is a hard contract, enforced by `pnpm run lint:determinism`.** Every function whose
result is not bit-identical across JavaScript engines is banned from the simulation, and
trigonometry is baked into tables at load. This is what makes a lap time mean the same thing
twice, and it is the foundation the trainer rests on.

### The circuits

| circuit | length | corners | speed range | how it was made |
|---|---|---|---|---|
| Spa-Francorchamps | 7013 m | 27 | 54–210 km/h | traced from the real circuit's diagram |
| Baku City | 6007 m | 19 | 59–209 km/h | traced from the real street circuit's diagram |
| Chicane | 5445 m | 17 | 53–206 km/h | authored as a radius profile |
| Club Circuit | 3521 m | 14 | 58–201 km/h | authored by hand |

The two real circuits are correct to within about 0.1 per cent of their true lap lengths. All four
are verified free of self-crossings and surface overlaps.

### The AI

`driver.ts` is a 38–16–3 neural network: 38 observations in, throttle, brake and steering out.
`sense.ts` defines the observation — eleven rays ahead, speed, attitude relative to the track,
engine state and tire use, all normalised.

**A driver is a pure function of its observation.** That makes a trained driver replayable and a
training run reproducible, and it means the viewer and the trainer run the identical simulation.

### The trainer

`evolve.ts` is an evolution strategy: antithetic perturbations, rank-normalised fitness, Adam on
the search distribution. `train.ts` runs it for a given number of hours and checkpoints the best
driver ever found, so an interrupted run is still worth the electricity.

```bash
pnpm run train -- --circuit spa --hours 13 --population 24 --seconds 90
```

---

## Things that are worth knowing before changing anything

These are not style preferences. Each one cost real time.

**A circuit's shape is an input, not an output.** An early version generated circuits by choosing
turn angles that sum to a whole number of turns and filtering for ones that do not cross. That
condition only says the loop *closes*, and the filter systematically keeps convex regular shapes
— every generated circuit came out looking like a rounded polygon. Real geometry was the fix.

**Two solvers and three attempts were spent on closing a path before the representation was
recognised as the problem.** Solving for the straight lengths that make a set of turns close is
ill-conditioned: the solver achieves closure by making straights hundreds of metres long or
negative. A ring of waypoints is closed by definition and needs no solving at all.

**Staying on the circuit has to GATE the score, not contribute to it.** With distance alone the
search learned that leaving the track is fast — on-track time fell from 80 per cent to 15 while
fitness rose.

**A pedal output of zero must mean a released pedal.** With a symmetric mapping centred at zero, an
untrained driver demanded half throttle and half brake together, sat motionless, and the search had
no gradient at all. Eighty generations produced no progress.

**The elite and its score must be recorded together.** Saving the search centre after the Adam step
rather than before it reported a best fitness of 1751 for a driver that measured 786.

**Reusing scratch state between evaluations makes scoring depend on the caller.** The obvious
optimisation to avoid allocating meant the same parameters scored differently depending on what had
been evaluated before. It was never worth it — a generation is dominated by the physics.

**Measure, do not reason, about geometry.** Repeatedly, a sign or a table that looked obviously
right was wrong by a constant, and only a test or a measurement found it.

---

## Where this is going

In rough order:

1. **Car-to-car awareness.** Rays against other cars, not just track limits.
2. **Collisions.** Between cars and against barriers, with damage.
3. **Sector timing per driver**, and purple sectors across a field.
4. **Racing.** Grid starts, lap counting, position, and a field of evolved drivers.
5. **Ratings.** Elo across a field, so drivers can be ranked rather than merely scored.

Longer term: a live training view, and a gallery of trained drivers to race against each other.

---

## Repository layout

```
packages/engine/src     simulation, circuits, driver network, trainer
packages/engine/test    unit tests, one file per module
packages/viewer/src     the browser viewer; runs the same engine source
packages/cli/src        train.ts and the static server
public                  viewer shell and build output
scripts                 browser build and the determinism linter
docs                    design notes and a chronological progress log
```

Training writes checkpoints to `checkpoints/`, which the build publishes into `public/` so the
viewer can drive from them. Neither is source control content.
