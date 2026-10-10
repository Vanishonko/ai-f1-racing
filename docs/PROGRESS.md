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

### 2026-10-10 — The start line was inside a hairpin

Pointed out that the drivers were missing the start of the lap because there is a hairpin there. Measured,
and it was worse than "a hairpin near the line":

    circuit   curvature at the line   radius      first corner   laps completed in 90 s
    club                 0.0382        26 m          26 m              0
    chicane              0.0031       323 m         135 m              0
    baku                 0.0031       323 m           0 m              0
    spa                  0.0028       357 m           0 m              0

**Club's start line sat at the apex of a 26 m radius hairpin.** Cars are placed on the line at rest, so
every run began with a standing start into a hairpin — the one corner a learning driver cannot take,
standing between it and the entire rest of the lap, on every single run. Its drivers never completed a
lap. Every checkpoint was measured from that standing start, and the lap reward, the objective the whole
ladder anneals towards, was never once paid.

**Fixed by moving the line, not the tarmac.** A circuit is a ring, so choosing a different index to
begin at changes only which point is distance zero — the geometry, the corners and the lap length are
untouched. This matters because the layouts are content that three previous attempts to "tidy" made
worse; this is the one edit to a circuit that cannot alter its shape. Each line is now at the middle of
its longest straight, which is where a real circuit puts it and for the same reason:

    circuit   straight chosen        line at    curvature at the line   first corner
    club      603 m, 2748-3350 m      3049 m          0.0032               301 m
    chicane   965 m, 4151-5115 m      4633 m          0.0032               482 m
    baku     1173 m, 5924-1090 m       503 m          0.0007               587 m
    spa       756 m, 6323-66 m        6701 m          0.0001               378 m

**Measured result on the same driver.** Club went from zero laps in ninety seconds to one, and from
39.36 m/s to 40.93 m/s over three minutes: the car is now released onto 301 m of straight instead of into
a hairpin, so it arrives at the first corner at speed instead of from a crawl.

Baku was the case that showed the principle already working. It was the only circuit whose line was at
the start of a straight rather than in a corner, and it was the only one where drivers made real
progress. Its longest straight straddles the wrap point, so the middle of it is reached by rotating
rather than by leaving the line alone.

**Guarded** by two tests in `track.test.ts`: the line must be on a straight by the same curvature
threshold `cornerCheckpoints` uses to define a corner, and there must be at least 150 m of run-up before
the first corner — because a line one metre before a hairpin is on a straight and still useless.


### 2026-10-10 — The checkpoint reward, and three more faults behind it

Asked to fix the checkpoint rewards, on the observation that they "kill the driving training after the
first lap, as they diminish too". The report was right about the symptom and the cause was worse than
the symptom suggested. Four separate faults, each of which alone would have been enough to stall a run.

**1. The checkpoint target did not carry its lap.** `car.distance` is the odometer and does not reset
at the line, so lap two's checkpoint at 26 m lives at 3,547 m of odometer. The target was the bare
position, so from lap two onwards every checkpoint read as already passed and the test was true on
every tick. Measured: 12,683 passes over three laps of a 42-checkpoint circuit, and zero credit, because
a whole lap's measurement was being taken inside a few metres just past the start line.

The previous investigation had checked this arithmetic, including a lap offset term, and concluded the
formula was correct. It was correct and it never ran: the offset was derived from a counter that was
reset to zero two lines later, so `floor(next / count)` was permanently zero. This is the second time
in this project that a fix was written, believed, and dead — so the guards are now tests against a
reintroduced fault rather than a reading of the code.

**2. One cut zeroed the entire lap.** Credit was skipped for the whole run if *any* checkpoint had been
crossed off-circuit, so one wheel on the grass at one corner forfeited all 42. Measured on the leading
driver: a single cut took its credit from 41 of 42 to exactly zero.

**3. The objective never changed, and the elite was ranked on the saturated half of it.** The record
ladder was `ladderFor(0)` — `{ lapReward: 0, checkpointReward: 500 }`, an objective on which a
completed lap is worth nothing — and that same option set was reused to score every sample, so the
annealing schedule described all over the code had never executed. The lap reward was worth exactly
zero in every generation of every run.

That explains the plateau precisely. The elite had already banked 40.99 of 42 checkpoints, so the
number it was judged by had nothing left that better driving could improve. Runs went flat a few
hundred generations in and no amount of training moved them, because the metric being watched was
already at its ceiling and the search was optimising a constant.

**4. The anneal horizon was set in generations while training runs in hours.** 2,500 generations is
half an hour at a measured 1.4 generations per second. Recomputing it against real durations gives
25,000: the corner reward stays worth having for about three hours and hands over to the lap inside a
working day.

**What the reward is now**, in answer to whether to lower it more slowly while raising the sector and
lap rewards — yes to both, and the numbers were chosen from measurement:

| term | before | after | why |
|---|---|---|---|
| lap | 5,000 (never applied) | 12,000 | the objective; more than the sectors combined |
| sector | 500, annealed to 0 in 2,500 gen | 250, annealed to 0 in 25,000 gen | dense per-corner signal, kept alive for hours |
| horizon | 2,500 generations | 25,000 generations | set from measured generations per second |

Sector credit is now a MEAN over the corners met rather than a run-long high-water mark, so the same
driving scores the same however long the run is, and every lap is measured on its own instead of the
first good lap setting a record nothing can beat.

**Verified.** Passes are exactly `laps x 42 + partial`. Credit sits at 0.83-0.86 on every lap where it
used to be 0.00. Fitness now RISES with run length — 16,523 at 90 s, 19,081 at 120 s, 25,855 at 240 s —
where before the reward actively paid a driver more for failing to complete a lap than for completing
one, which was the incentive the run length had been quietly creating all along.

A smoke run with the corrected reward is still improving at generation 3,233 with the elite at 0.85
credit, where the previous code was flat within a few hundred generations.


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


## Status after the physics fix, sector timing, and the circuit rebuild

### The car no longer drives itself

With throttle and brake both at zero the car used to accelerate BACKWARDS, reaching 4 m
of reverse travel in eight seconds. Three faults combined: `rpmFor` clamped its output
to idle so the wheel-derived engine speed read a constant 1800 rpm at a standstill and
the clutch thought the car was rolling; the engine's idle torque reached the road
through the gearbox; and engine braking could push a stationary car backwards. All
three are fixed, with a clutch engagement model added because that is the mechanism
real cars use. A regression test now pins both halves — the car must stand still for
20 s AND still pull away at 30% throttle.

Measured now: 0-100 km/h in 4.37 s, 0-200 in 8.03 s, 307 km/h top speed, 104.5 m to
stop from 200 km/h, and exactly 0 m of travel from rest with no controls.

### Sector timing, with purple sectors

`timing.ts` measures sectors from DISTANCE TRAVELLED, not position. Distance is
monotonic and already handles the start/finish wrap, so timing needs no geometry of its
own and cannot disagree with the track about where the car is. The viewer derives that
distance by projecting the car onto the centreline each physics step, which keeps the
physics core free of any notion of laps so it stays replayable and testable.

Showing the best time per sector makes it obvious where a lap is being won or lost,
which the total alone does not. Purple is a session best, green a personal best. The
bests live in the timing state rather than on a car, so a field can share one table —
that is what makes a purple sector mean something with several cars on track.

Six tests cover it, including the case that matters most: a step can cross two sector
boundaries at once when the car is quick and the tick is long, and a version that tested
only where the car ENDED UP dropped the boundaries it stepped over, producing laps with
missing sectors.

### The circuit set

| circuit | length | corners | speed range | overtaking zones |
|---|---|---|---|---|
| Spa-Francorchamps | 7013 m | 27 | 54-210 km/h | 9 |
| Baku City | 6007 m | 19 | 59-209 km/h | 8 |
| Chicane | 5445 m | 17 | 53-206 km/h | 5 |
| Club Circuit | 3521 m | 14 | 58-201 km/h | 4 |

Spa and Baku are traced from real circuit diagrams and are correct to within about
0.1 per cent of the real lap lengths. Chicane and Club are hand-authored.

The Chicane was rebuilt from a radius profile after measuring why it was pinched: the
previous ring bunched waypoints 6 to 12 degrees apart and changed radius sharply
between them, and a spline through a short, sharply-turning chord develops a far tighter
radius than either endpoint — a 13 m corner appeared in a section whose waypoint radii
were all between 600 and 700 m. Even spacing fixes it, because then the local curvature
is set by how fast the radius changes with angle, which is controllable directly.

### What is next

The trainer. The environment is now good enough to race on, which was the whole point of
doing the tracks first.


## The AI: what was built, and the six things it cost to get right

### What exists

A driver is a 38-16-3 neural network mapping a fixed observation to throttle, brake and steering.
`sense.ts` defines the observation: eleven rays ahead, speed, attitude relative to the track, engine
state and tire use, all normalised into a usable range. `evolve.ts` trains by evolution strategy.
`train.ts` runs for a given number of hours and checkpoints the best driver found.

A driver is a PURE FUNCTION of its observation. That single property gives a trained driver
replayability, a reproducible training run, and the guarantee that the viewer and the trainer run
the identical simulation rather than two implementations that drift.

### Six failures worth recording

1. **A circuit's shape is an input, not an output.** Generating turn angles that sum to a whole
   number of turns, and keeping the ones that do not cross, systematically keeps CONVEX REGULAR
   shapes. Every generated circuit came out looking like a rounded polygon, and the complaint was
   "this is not NASCAR" — correctly.

2. **Three solvers were written to close a path before the representation was recognised as the
   problem.** Solving for the straight lengths is ill-conditioned: the solver achieves closure by
   making straights hundreds of metres long or negative. A ring of waypoints is closed by
   definition and needs no solving.

3. **Staying on the circuit has to GATE the score.** With distance alone, over 130 generations
   fitness rose to 1249 while on-track time fell from 80 per cent to 15. The search had found that
   leaving the track is fast, because centreline distance keeps accruing across the infield.

4. **A pedal output of zero must mean a released pedal.** A symmetric mapping centred at zero made
   an untrained driver demand half throttle and half brake together. The car sat motionless, and
   with no movement there is no gradient: eighty generations produced literally no progress. Two
   attempted fixes then failed in opposite directions before the right shape was found.

5. **The elite and its score must be recorded together.** Saving the search centre AFTER the Adam
   step rather than before it meant the recorded parameters were not the ones that earned the
   score. The run reported a best fitness of 1751 for a driver that measured 786.

6. **Reusing scratch state between evaluations makes scoring depend on the caller.** The obvious
   allocation-saving optimisation meant the same parameters scored differently depending on what
   had been evaluated before. A generation is dominated by the physics, so the saving was never
   worth it.

There is a seventh, methodological one, and it is the oldest lesson in this log: **measure, do not
reason, about geometry and numerics.** A baked logarithm was written three times and was wrong three
times — the wrong argument, then a stray `+1` that made `log(1)` non-zero, then a descending table
so every lookup returned an endpoint. Each version looked obviously correct. Only measuring the
error found them.

### Where it stands

Training runs and improves the driver it is given. Measured over a three-minute run: mean sample
distance 0 → 555 m, best driver 422 m in 120 s at 85 per cent on track.

What does NOT exist yet, and is next: car-to-car awareness, collisions, damage, per-driver sector
timing across a field, grid starts, positions, and Elo ratings. The racing, in other words — which
is the point of the exercise and the reason the environment was worth getting right first.
