# Known issues

## Checkpoints stopped measuring after the first lap — FIXED, and there were four faults

Found by asking whether the drivers can sense the checkpoints. They cannot — the observation has no
checkpoint input — so the reward is the only thing steering them towards one, and it was not working.

    duration   laps   passes (before)   passes (after)   credit (before)   credit (after)
      90 s       0          208               43            0.00              0.86
     120 s       1         1,577              55            0.00              0.83
     180 s       2         5,443              85            0.00              0.86
     300 s       3        12,683             143            0.00              0.83

Passes are now exactly `laps x 42 + partial`, and credit is measured on every lap.

**Fault 1 — the checkpoint target did not carry its lap.** `car.distance` is the car's odometer and
increases across laps instead of resetting at the line, so lap two's checkpoint at 26 m sits at
3,547 m of odometer. The comparison used the bare position, so from the second lap on every checkpoint
read as already passed and the test held on EVERY tick. The whole lap's measurement collapsed into a
few metres just past the start line.

This is worth recording because the previous investigation had verified the target arithmetic
*including* the lap offset and concluded the formula was right. It was — but the offset was computed
from a counter that was being reset to zero at the end of every lap two lines later, so
`floor(next / count)` was permanently zero. The written fix never executed. Replacing it with a
separate lap counter that is folded into the target is what made it work, and the first attempt at
this repair reintroduced the fault by "simplifying away" what looked like dead code.

**Fault 2 — one cut zeroed the entire lap.** Credit was skipped for the whole run if ANY checkpoint
was flagged as crossed off-circuit, so a single wheel on the grass at one corner forfeited all 42.
Measured on the project's leading driver: one cut took its credit from 41 of 42 to exactly ZERO.
Missed checkpoints are now forfeit individually.

**Fault 3 — the objective never changed, and the elite was ranked on the part that had saturated.**
`recordLadder` was set to `ladderFor(0)`, which is `{ lapReward: 0, checkpointReward: 500 }` — an
objective on which a completed lap is worth nothing. Worse, that same option set was reused to score
every SAMPLE, so the annealing schedule described throughout the code never ran: the lap reward was
worth exactly zero in every generation of every run.

The consequence was measurable and matched the symptom exactly. The elite had already banked 40.99 of
42 checkpoints, so the recorded score had nothing left that a better lap could improve; runs showed a
flat line from a few hundred generations in, and no amount of training moved it. Measured now:

    before:  elite 41.00 / 42 checkpoints, lap reward 0,    fitness flat for hundreds of generations
    after:   elite  0.85      per lap,     lap reward paid, search still improving at generation 3,233

The elite is now recorded against a fixed racing objective (`REFERENCE_LADDER`, a separate constant
so the anneal can be retuned without invalidating recorded scores), and the samples anneal as the
comments always claimed.

**Fault 4 — the anneal horizon was measured in generations while training runs in hours.** The
schedule was 2,500 generations, which at a measured 1.4 generations per second is half an hour; the
first correction tried here, 6,000, was spent inside the first hour. Either way a run left going
overnight spent nearly all of it with the corner signal at zero. Recomputed against real durations and
set to 25,000, which keeps the corner reward worth having for about three hours and hands over to the
lap well inside a working day.

**Guarded by** `packages/engine/test/sectors.test.ts` and the ladder tests in `evolve.test.ts`. The
sector tests were checked against both faults by reintroducing each one and confirming they fail.

---

## The start line sat inside a hairpin — FIXED

Cars are placed on the line at rest, so a line drawn in a corner means every run begins with a standing
start into that corner. Measured, the club circuit's line was at curvature 0.0382 — a **26 m radius
hairpin** — and its drivers never completed a lap. Every checkpoint was measured from a standing start
into a hairpin, and the lap reward, the objective the whole ladder anneals towards, was never paid.

Baku was the only circuit whose line was already at the start of a straight rather than in a corner, and
it was the only one where drivers made real progress, which is what identified this.

Fixed by rotating where distance zero falls on the ring, which moves the line without moving any tarmac.
Each line is now at the middle of the longest straight; club went from zero laps in ninety seconds to
one, at 40.93 m/s over three minutes instead of 39.36. Guarded by two tests in `track.test.ts`: the line
must be on a straight, and there must be run-up before the first corner.

---

## The viewer and the trainer drive the same driver differently

**Found:** the club-circuit elite completes three quarters of a lap of Spa and averages 105 km/h when run
by the trainer's evaluation loop, and does 0 km/h in the browser on the same circuit with the same
parameters.

**Reproduced outside the browser.** Copying the viewer's loop exactly — `observe`, then `drive`, then
`stepCar`, feeding the observation's own distance back as the projection hint — gives the same failure:
throttle climbs to 0.87 on the first tick and collapses to 0.00 by five seconds, with the steering
slamming between full left and full right. The trainer's loop over the same driver and circuit holds
105 km/h with 86 per cent of the run on the circuit.

**What differs, and where to look.** The two loops agree on the physics and the network; they differ in
how the track projection is seeded and carried. The trainer gets its start state from a cached function
that computes the heading once per circuit, while the viewer places the car with `pointAtDistance` and
carries `lastProjectedS` separately. If the hint passed to `observe` disagrees with where the car actually
is, `projectToTrackNear` searches the wrong region and every ray reports the wrong distance — which is
exactly the symptom, because the driver's first action is to steer hard on bad information and it never
recovers.

**Why it matters beyond the viewer.** Anything that drives a car outside `runDriver` — the viewer, the
replay button, any future tool — has to reproduce the trainer's loop precisely or it is testing a
different driver. The fix is to move the loop into one place that both use, rather than to correct the
viewer's copy.

**Note that the trainer is the correct one:** it is the loop the search is scored in, so if the two ever
disagree the trainer is the definition.

---


## The car spins where it should understeer

**Found:** asking for more steering lock than the tires can supply. A real car understeers — the front
loses grip first and the car ploughs wide, which is slow, obvious and recoverable. Ours spins: the rear
axle loses grip first, so the car rotates and ends up travelling backwards.

**How it presents.** At a held 120 km/h the car is stable to 0.15 of steering command with 0.3 degrees of
slip, and spins at 0.20. The limit is sharp and geometric rather than vague: 0.275 radians at that speed
demands 3.75 g against roughly 2.5 g available, so the request is simply impossible — but the way the car
fails is the wrong way round.

**What was ruled out.** Weight distribution was swept from 0.40 to 0.55 front and rear downforce from 6,900
to 9,000 newtons, and neither changes it, so this is not a balance problem that a setup can fix. The
balance is already slightly rearward as a real single-seater is.

**Where to look.** The tire model past saturation. A real tire's lateral force peaks and then falls away
gradually, and that falling slope is what makes a sliding car want to straighten itself. This model's force
curve saturates and stays there, so once the rear is past its peak there is no mechanism pulling the car
back into line and the yaw runs away.

**Why it matters more than it sounds.** A car whose limit is a cliff rather than a slope is the hardest
possible thing to learn against, because there is no gradient telling the driver it is close. Every
training run so far has been learning against this.

---


## The launch is traction-limited, so 0-100 is a second and a half slow

**Found:** auditing the car against real Formula 1 figures. Braking and top speed now match; the launch
does not.

    sim      0-100 km/h in 4.0 s      real F1 about 2.6 s
    sim      0-200 km/h in 6.2 s      real F1 about 4.8 s

**What is happening.** From rest at full throttle the engine reaches its 15,000 rpm limiter while the
car is still at walking pace, with the rear wheels spinning tens of metres per second faster than the
road. The car is not accelerating, it is destroying its tires.

**Why the obvious fix does not work.** Drive torque is already capped at what the rear tires can put
down — measured, the cap is 2,202 Nm against an uncapped 9,687 Nm and it is definitely being applied —
and it is not enough. The reason is inertia: a wheel is 1.1 kg·m², an effective 10 kg against a 798 kg
car, and first gear multiplies engine torque by 12.58. Any excess torque whatsoever spins a wheel up
almost instantly, and the tire's force falls away as slip grows, so the wheel runs away faster than the
tire can pull it back.

**What a real car has that this does not:** a clutch model, which is what actually meters torque during a
launch, and an engine map that softens the low-rpm response. Launch control is a genuine sub-system
rather than a constant to tune.

**Not fixed because:** getting it wrong destabilises everything else, and braking and top speed were
already brought into line in the same pass. The next step is a proper clutch engagement curve during
first gear, not another torque cap.

---

## Two tests fail after the downforce and power changes

Both are measuring the wrong thing rather than reporting a fault, which took a while to establish:

  - `car: tire wear degrades grip and eventually matters` compares PEAK LATERAL ACCELERATION between a
    fresh and a worn car, both at full lock and full throttle. That measurement is an uncontrolled
    spin-out, so it depends on power and downforce as much as on grip. Measured directly, wear behaves
    correctly: 1.36 g fresh, 1.21 g at half wear, 0.98 g fully worn.
  - `car: throttle is an analog control with a non-trivial optimum` encodes the old power delivery,
    which traction control and a thousand horsepower changed.

Both need rewriting to measure grip rather than the outcome of a slide.


Things that are wrong and are not yet fixed, written down so they are not rediscovered from scratch.
Each entry says how it was found, because the way a bug presents is often more useful than the bug.

---

## The car can park itself and never move again

**Found:** training runs stop improving at around two and a half kilometres of a three and a half
kilometre lap, and the elite measures *worse* over a longer run than a short one. A driver covering
2,818 m in 90 seconds covers only 4,110 m in 180 — the extra time is spent stationary.

**What it looks like.** Traced at 60 Hz, the car is driving normally at 87 km/h, then within six
seconds it is at zero, and it stays at zero for the remaining twenty seconds of the trace with the
brake held at 0.59–0.75, the throttle at 0.00–0.03 and the steering near full lock. Its position does
not change: `x 316, y -93` for every sample. The wheels are not locked and the tires are not
saturated; the car is simply not being moved by anything.

**Why it matters beyond itself.** A driver that stops is scored on a fraction of a run, so the search
sees a ceiling that is not real. Every long run so far has plausibly been limited by this rather than
by the driving.

**Not yet established:** whether the car is facing backwards (which would make the brake and the drive
torque fight to a standstill), whether the tire's longitudinal force changes sign near zero speed, or
whether the issue is in the wheel rotational integration. The next step is to reproduce it from a
known state rather than from a trained driver — a car at zero speed with the brake held should stay
stopped, and a car at zero speed with no brake should not.

**A related symptom, measured since, and it is NOT this fault.** On the Chicane circuit a club-trained
driver covers 0.2 m in forty seconds with the throttle at exactly 0.00 every single step: it never asks
to move. The car is capable — a fixed full-throttle-straight policy covers 558 m there in twenty
seconds — so this is a policy that has never learned to apply throttle from rest on an unfamiliar
circuit, not a car that cannot launch. Worth separating, because the two look identical in a distance
column and have nothing in common underneath.

**Where to look:** `packages/engine/src/car.ts` around the wheel torque integration and
`packages/engine/src/tire.ts` for the slip ratio at low speed. `MIN_REFERENCE_SPEED` exists to keep the
slip ratio well defined near zero and is the most likely place for a sign or magnitude error.

---

## Every long training run has stalled, and each time for a different reason

Seven separate causes have now been found and fixed, and it is worth listing them together because they
presented identically — a training curve that rose and then flattened:

1. **Rank normalisation with ties.** Nearly every sample scored zero early in training, and ranking
   ties assigns them an arbitrary order, so the gradient was noise averaging to zero. Replaced with
   standardisation.
2. **The elite reset.** Snapping the centre back onto the elite whenever it scored worse — which is
   always — discarded the Adam step every generation. Measured, the centre and elite were identical
   to fifteen decimal places for hundreds of generations.
3. **A reward that could be farmed.** An ungated distance reward paid for driving in a straight line
   off the circuit. Over 14,000 generations the best driver found was 97 per cent off the track.
4. **A record scored under a moving objective.** The ladder anneals, so an elite recorded at 9,615 was
   worth 1,174 under the objective in force sixteen hundred generations later. The search could not
   reproduce a score it had already beaten.
5. **The anneal never ran, and the record measured only the half of the objective that saturates.**
   The record's generation-zero ladder was written into the option set used to score every sample, so
   the lap reward was worth zero in every generation of every run while the comments described a
   schedule that was not being applied. Meanwhile the elite had already banked 40.99 of 42 checkpoints,
   so the number it was judged by had nothing left that better driving could improve. See the checkpoint
   entry above.
6. **The anneal horizon was set in generations while training runs in hours.** 2,500 generations is
   half an hour at a measured 1.4 generations per second, so a run left going overnight spent nearly all
   of it with the corner signal at zero. Now 25,000, chosen from a table of real durations.
7. **The start line sat inside a hairpin.** Cars are released from rest on the line, so this put a 26 m
   radius corner between the car and the entire rest of the lap on every single run, and the lap reward
   was never paid at all. See the start line entry above.

Each was invisible in the fitness column and obvious in a different one — ties in the sample spread,
the reset in the centre-to-elite distance, the farmed reward in the on-track fraction, the moving
record in a re-measurement, the dead anneal in the fact that the lap reward term was zero, the horizon
in the wall-clock duration of a run, and the hairpin in the curvature at distance zero.

**The lesson worth keeping:** when a training curve flattens, the fitness number is the least
informative column in the log. Not one of these seven was found by looking at it.
