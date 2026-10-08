# Progress

A running log of what is built, what is measured, and what is next. Updated as
work lands, so the state of the project is never only in someone's head.

## Current state

**Milestone 2 (Watch a lap) — reached.** You can drive the car around a real
circuit in the browser at `pnpm drive`.

| Piece | State |
|---|---|
| Tire model: combined slip, friction circle, load sensitivity | Done, 11 tests |
| Load transfer, brake bias, axle balance | Done, tested |
| Powertrain: torque curve, gearbox, differential, rev limiter | Done, tested |
| Chassis integration with wheel substeps | Done, 11 tests |
| Track generation and hand-authored layouts | Done, tested |
| Drivable browser viewer | Done, verified at 238 km/h |
| Determinism contract + linter | Done, verified to catch violations |
| Surface grid, runoff, track limits | Not started |
| Collision, car-vs-car and barriers | Not started |
| Observation vector (60 floats) | Not started |
| Race operations: laps, tires, fuel, pits, damage | Not started |
| ES trainer, islands, checkpoints | Not started |
| Live streaming, gallery, ratings | Not started |

Tests: **29 passing, 0 failing** (`pnpm test`).
Determinism lint: **clean**. Typecheck: **clean**.

Known flaws, recorded rather than hidden:
- Full-throttle wheelspin costs less than it should, because the tire model has no
  thermal limit and the rev limiter caps wheel speed. `throttleScale` now exists so
  the trainer can discover modulation anyway, and the launch sweep shows a real
  optimum at about 70% throttle.

### Track generation: what failed, and the honest assessment

Asked to generate the tracks properly rather than ship circles and rectangles. I
could not do it, and the reasons are worth recording so it is not retried blindly.

**The solver is correct.** `trackDesign.ts` fixes the turn ANGLES and solves for
the straight lengths. With angles fixed the endpoint is affine in each length, so
each can be solved in closed form in turn and coordinate descent converges to
zero. Verified: irregular angle sets close to 0.0000 m. A previous closed-form
polygon identity was tried and abandoned — it closed a square exactly and was
0.7 m wrong on an irregular quadrilateral, which is the case that matters.

**But closure does not imply a valid shape.** Two failure modes, both fatal:

- A closed polygon with unequal straights WRAPS AROUND ITSELF. A design that closed
  perfectly plotted as a spiral, because straights of 300 m and 846 m in the same
  loop make it wind.
- Crossing is structural in the ANGLE PATTERN, not the radii. Scaling every corner
  radius from 1.0x down to 0.16x left the crossing count at 2 through the whole
  range: the angles set the shape, and radii only change how tightly the path turns
  through it. So no amount of tuning fixes a pattern that crosses.

Roughly sixty thousand generated designs were attempted in total. Those that closed
and did not cross were never also well proportioned, and vice versa.

**Two things that were claimed and were wrong.** A "chicane block" described as
provably heading- and position-neutral displaces by 90 m sideways, not the 4R
forward I calculated; a rotation was omitted from the composition. And an earlier
claim that the club had three slow corners at 58 km/h was measured on a version
that had already been replaced. Both are recorded because the pattern — asserting a
geometric result without measuring it — is what wasted most of this session.

**What is actually true of the shipped tracks**, measured corner by corner:

| track | length | corners | speeds | longest straight |
|---|---|---|---|---|
| The Oval | 2319 m | 2 | 126 km/h | 1105 m |
| Hairpin | 2313 m | 5 | 76-127 km/h | 855 m |
| Chicane | 2504 m | 7 | 63-132 km/h | 925 m |
| Club Circuit | 3516 m | 13 | 64-137 km/h | 845 m |

All four are clean: no self-crossings, no surface overlaps, projections exact.

**THE REAL FAULT, which the user identified and I had not measured:** no corner on
any track exceeds 175 km/h. Everything sits in a 63-137 km/h band. The car is
capable of 300 km/h and the circuits never ask for it, so there is no high-speed
section, no heavy braking from top speed, and therefore no real variety. The Chicane
and Club are legitimate circuits with straights and multiple corner types; the Oval
genuinely is a rounded rectangle and should be replaced rather than kept.

Track state (all four clean — no self-crossings, no surface overlap):

| track | length | tightest corner |
|---|---|---|
| The Oval | 2319 m | 81 m (126 km/h) |
| Hairpin | 2313 m | 24 m (70 km/h) |
| Chicane | 2504 m | 19 m (61 km/h) |
| Club Circuit | 3290 m | 20 m (62 km/h hairpin at the end) |

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


### Standing start, tracks, and the drivable viewer

Added the track library and a viewer you can actually drive, then spent most of
the session finding bugs in the drivetrain. **Every one of the nine below was
found by logging a run and reading the numbers, not by reasoning about the code.**
Several of them had already been "fixed" twice by reasoning, badly.

**Tracks.** Closed Catmull-Rom centreline resampled at uniform ARC LENGTH.
Spacing matters: the car's track position, grip-noise lookup and lookahead all
index by distance, so spacing by spline parameter would make a car at constant
speed appear to accelerate and decelerate through corners. Four layouts, each
targeting a different skill, measured at 22.8 m (hairpin), 40.7 m (chicane) and
a 126 km/h sweeper on the oval. Projection round-trips to 0.002 m.

Curvature needed its own fix: differencing the tangent between ADJACENT 0.5 m
samples is numerically meaningless, because the tangent barely rotates over that
distance and the result is float noise divided by a small arc length. It reported
the 20 m hairpin as a 632 m sweeper. Now differenced over 4 m and smoothed.

**The nine bugs.**

1. **No aerodynamic drag.** The car reached 441 km/h on a straight, which made
   every braking distance meaningless. Now a 315 km/h terminal velocity.

2. **Nothing coupled a coasting wheel to the road.** The car never stopped; it
   settled at 0.4 km/h forever. Added rolling resistance, which also gives
   lift-and-coast something physical to stand on.

3. **A stopped car drifted BACKWARDS.** Below the slip reference speed the force
   sign is noise, so it oscillated and crept to -0.66 m/s. Added a narrow
   low-speed settling rule that cannot mask real dynamics under power.

4. **The engine had a road-car torque curve.** Torque rose linearly from zero at
   zero RPM, giving 12% of peak at idle, so a standing start crawled away at 3 m/s
   after a full second of full throttle. The launch was not grip-limited; the
   engine was barely running. Race engines make most of their torque from low
   revs, and the curve now reaches 0.43 at idle.

5. **Gearbox hunting.** Two-threshold shifting produced 1-2-1-3 within two
   seconds, because an upshift landed the next gear BELOW the downshift threshold.
   Replaced with a schedule derived from the torque curve. A wheel-torque
   criterion concluded the car should never shift at all — first gear multiplies
   by 3.4 against second's 2.6 and engine torque never closes that. The correct
   criterion is POWER, not torque.

6. **Wheelspin confused the gearbox.** Engine speed derived from the driven
   wheels meant the box shifted on wheel speed rather than road speed, hunting
   between first and second at 83 km/h. The gearbox now decides from a rolling
   engine speed while the engine keeps using actual speed for torque and the
   limiter.

7. **Tire wear accumulated per SUBSTEP rather than per second**, so it scaled
   with the substep count. At 16 substeps the tires hit 100% wear six seconds into
   a standing start, grip collapsed to 65%, and the car span its wheels and lost
   speed. A unit error whose symptom looked exactly like a physics bug.

8. **No rev limiter.** The log read 15,512 rpm against a 15,000 limit. The
   limiter now also FORCES an upshift: a spinning wheel sits above the upshift
   threshold while the fuel cut has zeroed torque, so a demand-gated shift never
   fires, no downshift can fire either, and the car is trapped in one gear at
   zero drive torque.

9. **Brake bias was 40% rear**, too much for the load distribution, so the REARS
   saturated first — the opposite of what the tire model exists to produce.
   Swept it: 0.64 gives near-simultaneous lockup with the highest deceleration.

**A model recalibration that changed the design, not just a number.** Measuring
the complete car rather than a single force showed that at the published value of
0.86 of peak, locking the brakes was STRICTLY OPTIMAL over a full stop: a locked
wheel holds a steady 0.86 while any modulating controller necessarily spends time
at low slip making almost none, so the locked car stopped **21% SHORTER**. The
simulation was rewarding a pedal slam. Sliding is now 0.70 of peak, deliberately
harsher than a real slick, and a test measures the whole stop to keep it that way.
From 200 km/h, locking now costs 13.3% more distance plus the steering loss.

**Tooling.** Added a TypeScript typecheck gate. Node strips types without
checking them, so a wrong arity, a bad property name or a bad assignment all fail
at runtime or not at all. This caught three real errors the moment it was added,
and the viewer is now typechecked too rather than being loose JavaScript behind
the build.

**Worth recording as a process lesson:** three times this session I "fixed" a bug
by reasoning about the code, only to have the symptom persist or move. The fixes
that worked came from printing the actual state — wheel speeds, forces, loads —
and reading it. The brake-bias and lockup-order questions in particular were
answered in seconds by a table of numbers after a long stretch of unproductive
deduction.


### Steering, tracks, and analog throttle

**Three corrections from driving the thing, and one of mine that was wrong.**

**1. Steering was inverted, and I made it worse before fixing it.** Measured in
the running page: `steerCommand = -1` produced `dHeading -24.6°`, and a negative
canvas rotation is clockwise, which is a right turn. The sign convention was the
bug. I then "fixed" it by negating the wheel rotation in the engine and inverting
the key mapping — and broke the thing I was trying to repair, because the mapping
had been right all along. Reverted both, then measured the keys themselves
(`A` -> `dHeading +21.1°` = left, `D` -> `-57.0°` = right) to confirm.

The lesson is worth keeping: **every force, moment and load transfer in the car
was self-consistent while it turned the wrong way.** No test written from the same
mental model that produced a sign error can catch that sign error. It took driving
it. There is now a test pinning BOTH directions plus the zero case, so the next
inversion fails loudly.

Also fixed the steering indicator bar, which filled the wrong way for the same
reason.

**2. The club circuit was the good one and I destroyed it.** Chasing a "final turn
that overlaps itself", I rebuilt every layout into something straighter and much
duller. The original Club Circuit was then measured and does NOT cross itself —
the overlap is a visual pinch in the right-left flick at [270,25] -> [140,-45],
which is exactly the part that gives the lap its character. Restored, and the
library now says in plain text that the block is content rather than scaffolding.

**The Hairpin is the one that genuinely self-crosses** (three times near
s = 660 m), and I failed to fix it cleanly: every attempt to open it up produced a
worse circuit and two of them added more crossings than they removed. So it is
documented rather than fixed — the ambiguity is confined to the crossing, which a
test now asserts, and everywhere else projection is exact to a fraction of a
millimetre. Redesigning that circuit is a content decision, not a tuning one.

Added `selfIntersections` to the engine and wired it into `validateTrack`, because
a crossing makes the `(s, d)` projection ambiguous and quietly breaks progress and
lap counting. The detector is itself guarded by a test that feeds it a bowtie that
genuinely crosses, since a detector that never fires would pass everything.

**3. Launching and throttle modulation is now a real objective.** Added
`throttleScale` to the step context so a policy can feather the power, matching
what `brakeScale` already allowed for the brakes. It is not cosmetic:

```
throttle  time to 100 m   wheelspin
    0.60       5.650 s      0.00 s
    0.70       5.317 s      0.38 s   <- best
    1.00       5.533 s      6.96 s   <- 4.1% slower, and a destroyed set of tires
```

Full throttle is not optimal, because a spinning wheel is past its slip peak and
the fold-back means more slip makes less forward force. A test asserts that a
partial throttle beats full, that too little is clearly worse, and that full
throttle abuses the tires more — so "learn to launch the car" is verifiable rather
than aspirational.

**Process note, the real lesson of this stretch:** I have now got a sign or a
shape wrong by reasoning about it four separate times, and each time the fix that
worked came from measuring — reading the heading out of a live page, printing the
generated points, or sweeping a parameter. Two of my four "fixes" made things
worse. The tests are better for it, but the pattern is consistent enough to name:
when the code is self-consistent and the behaviour is wrong, stop reasoning and go
read the numbers.


### Overlapping straights, a rebuilt hairpin, and crude smoke

**The overlap was real and measurable.** The Club had two long straights at
y = -170 and y = -180 while each carried a half-width of 8.5 m. They were 10 m
apart, so the two SURFACES genuinely overlapped along their whole length and the
track read as one fat ribbon. Measured closest approach was **4.9 m against the
17 m needed to stay clear.** Replaced with a proper end complex: a long run down
the right, a tight hairpin, and a straight back to the line.

**The Chicane overlapped too** (1.9 m), and the Hairpin genuinely self-crossed
three times. Both are fixed. All four layouts now measure clean:

| track | length | tightest | clearance |
|---|---|---|---|
| The Oval | 2319 m | 81 m | 77 m |
| Hairpin | 2313 m | 24 m | 25 m |
| Chicane | 2504 m | 19 m | 45 m |
| Club Circuit | 3290 m | 20 m | 28 m |

**The fix that unblocked all of it** was a corner-filleting helper. I had been
placing apex points by hand and testing afterwards, which produced layout after
layout whose legs doubled back through each other — roughly a dozen failed attempts
across the session. `fillet.ts` takes an ordinary polygon and inserts a quadratic
arc at every corner, so every turn has a radius BY CONSTRUCTION and the radius
becomes a single number to tune. The first circuit built with it validated
immediately at 29 m radius, and the two worst offenders were rebuilt cleanly in one
attempt each.

A detail worth recording, because it caused two more crossings: filleting SHORTENS
each edge it touches. Squeeze a hairpin tighter than that allows and the leg corner
and the U corner fillet into each other. The hairpin's U ends are therefore spaced
175 m apart and its legs 250 m apart, which is what leaves room for both fillets.

**The old flaw is gone and its test with it.** The Hairpin no longer crosses itself,
so the test that documented the crossing is replaced by one that checks BOTH failure
modes across every layout: topology (no self-crossing, which would make the `(s, d)`
projection ambiguous) and clearance (no surface overlap, which is a separate
measure). Neither existed before, which is why both shipped.

**Smoke, deliberately cheap.** Emitted when a tire is sliding past 45% slip, drawn
as fading discs from a flat ring buffer, off by default behind a toggle. It is a
visual aid for seeing where the limit is, not a fluid sim.

It lives in the viewer and NOT in the engine, which is the important part:
particles are a rendering concern with a random element, and the engine's
determinism is what makes replays reproducible from a seed. A cosmetic effect must
never be able to break that, so the engine has no idea this exists.

## Next

1. Surface grid with runoff and track limits, so running wide costs time rather
   than ending the run. This is the piece that makes kerbs and gravel real.
2. Collision: car-vs-car capsules and barriers, with damage.
3. The 60-float observation contract, which is what makes track transfer work.
4. A bench harness, so throughput is measured before any long run is promised.
5. The ES trainer behind the `Driver` interface.

## How to check the state

```bash
pnpm test                  # 11 tests
pnpm run lint:determinism  # sim core must contain no forbidden math
```
