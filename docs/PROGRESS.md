# Progress

A running log of what is built, what is measured, and what is next. Updated as
work lands, so the state of the project is never only in someone's head.

## Current state

**Milestone 1 (Sim truth) — in progress.**

| Piece | State |
|---|---|
| Tire model: combined slip, friction circle, load sensitivity | Done, 11 tests green |
| Load transfer, brake bias, axle balance | Done, tested |
| Determinism contract + linter | Done, verified to catch violations |
| Scalar/vector math helpers with baked trig policy | Done (minimal) |
| Powertrain: torque curve, gearbox, differential | Not started |
| Chassis integration with wheel substeps | Not started |
| Track generation + validation | Not started |
| Surface grid, runoff, track limits | Not started |
| Collision, car-vs-car and barriers | Not started |
| Racing line / curvature LUT for observation | Not started |
| Observation vector (60 floats) | Not started |
| Race operations: laps, tires, fuel, pits, damage | Not started |
| Viewer, replay, live streaming | Not started |
| ES trainer, islands, checkpoints | Not started |
| Fitness, ratings, gallery | Not started |

Test suite: **11 passing, 0 failing** (`pnpm test`).
Determinism lint: **clean** (`pnpm run lint:determinism`).

## Log

### 2026-02-xx — Tire model, load transfer, and the lockup correction

Built the tire model, the part of the sim that decides whether the racing is any
good, since everything downstream depends on lockup and wheelspin being real.

**Corrected a wrong assumption.** I had written that locking the *rears* rotates
the car and would be the interesting failure mode. Wrong, and the user caught it:
under braking, load transfer unloads the rear and loads the front, so with forward
bias **the fronts lock first**, and a locked front makes the car go straight. The
initial model had no load transfer at all, which is what made "which axle locks"
arbitrary. Added longitudinal and lateral load transfer, and made front lockup
emerge from it rather than being scripted.

**Measured behaviour after the fix:**

```
                               fx      fy     |F|      state
rolling, at lateral peak     0.000  -0.991   0.991    gripping
LOCKED, at lateral peak     -0.876  -0.094   0.881    locked
rolling, 0.25 rad            0.000  -0.986   0.986    gripping
LOCKED, 0.25 rad            -0.866  -0.212   0.892    locked
braking at peak slip, no lat -1.011   0.000   1.011   gripping
locked straight, no lat     -0.893   0.000   0.893    locked
```

Locking keeps ~88% of braking force and loses ~90% of cornering force. The
resultant rotates from pointing sideways to pointing backwards, which is why the
car stops turning.

**Four bugs found and fixed, three of them mine in the model:**

1. **The demand curve peaked at m=1.41, not m=1**, because I normalised by the
   *sampled* table maximum and the grid's own maximum landed above the true peak.
   The tire overshot the friction circle by 5%. Fixed by normalising by the
   analytic peak.
2. **Anisotropy was applied to the slip input**, pushing lateral slip past its own
   peak and distorting the curve. Moved to the output.
3. **Floating-point peak miss**: `-0.11 / 0.11` is `-0.9999999999999999`, not
   `-1`, so the peak lookup straddled a table interval. Added an explicit epsilon.
4. **The important one.** The friction-circle scale was computed as
   `budget / |demand|`, and because the fold-back drives demand far past the budget
   at high slip, that scale grew with slip and **exactly cancelled the fold-back**.
   A fully locked wheel braked *identically* to a perfectly modulated one — the sim
   was rewarding lockup. Fixed by splitting force magnitude (one bounded fold-back
   curve) from direction (a unit vector), so no clamp is needed and the fold-back
   survives. Worst-case resultant/budget ratio is now exactly 1.0, verified by a
   numeric sweep that is pinned as a test.

**Also corrected two of my own test assumptions**, which is worth recording
because the tests were wrong rather than the code:

- I asserted that locking the rears *adds* yaw moment. It does not — a locked rear
  produces *less* force. The car steps out because the rear's **share** of grip
  collapses, not because it generates extra yaw. Rewrote the assertion around
  balance share.
- I asserted that more steering lock makes a locked front worse. It is more
  subtle: locked yaw authority does creep back up with slip angle (a tire sliding
  at a larger angle still makes some lateral force), it just never returns to
  gripping levels. The honest assertion is "more lock cannot recover it."

Calibration choice now pinned by test: a locked tire retains 70–92% of peak
braking. This number decides how punishing a lockup is in the reward function, so
it is asserted rather than left to drift.

## Next

1. Powertrain — torque curve, gearbox, differential, brake bias as a setup gene.
2. Chassis integration with wheel substeps.
3. Track generation and validation.
4. A bench harness, so throughput is measured before any long run is promised.

## How to check the state

```bash
pnpm test                  # 11 tests
pnpm run lint:determinism  # sim core must contain no forbidden math
```
