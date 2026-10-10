# Known issues

## Checkpoints stop measuring after the first lap — OPEN, and it invalidates every long run

**Found:** asking whether the drivers can sense the checkpoints. They cannot — the observation has no
checkpoint input at all — so the only thing steering them towards one is the reward. Measured, they are
not being rewarded at all past the first lap.

    duration   laps   checkpointsPassed   credit earned   best speed fraction
      60 s       0            26            21.7 / 42           3.74
      90 s       0           208             0.0               0.00
     120 s       1          1577             0.0               0.00
     180 s       1          5443             0.0               0.00
     360 s       3         16425             0.0               0.00

**The pass count grows without bound and the credit collapses to zero.** Credit is skipped for any
checkpoint crossed while off the circuit (`checkpointOnTrack`), so a runaway index marking thousands of
crossings means nearly every checkpoint ends up flagged, and the reward stops distinguishing anything.

**Where it is.** `nextCheckpoint` advances by one each time `car.distance >= target`, and the target is
`positions[nextCheckpoint % count] + floor(nextCheckpoint / count) * track.length`. That arithmetic was
CHECKED INDEPENDENTLY, replayed against a real distance trace, and gives the correct 85 passes over
180 seconds — so the formula is right and the fault is in how the loop advances the index. Once
`nextCheckpoint` runs far past the checkpoint count, the lap offset grows faster than the car travels and
the sequence of crossings becomes meaningless.

**Not yet found:** why the index advances more than once per checkpoint. The per-tick distance
accumulation was verified correct by hand — 2,672 m in 80 seconds, matching the track — so the fault is
in the comparison, not the distance.

**Why this is the most important open item.** The checkpoint ladder is the main signal that teaches
cornering. If it stops measuring after one lap, then EVERY LONG RUN SO FAR HAS BEEN TRAINED ON A BROKEN
REWARD FROM LAP TWO ONWARDS, and the plateaus that kept appearing — the elite stuck from generation 448
onwards, the earlier one stuck from generation 5,216 — have a common and now plausible explanation.

The observation window is 90 seconds by default, which is why this went unnoticed: at that length the
run only just reaches the second lap, where the damage begins.

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

**Where to look:** `packages/engine/src/car.ts` around the wheel torque integration and
`packages/engine/src/tire.ts` for the slip ratio at low speed. `MIN_REFERENCE_SPEED` exists to keep the
slip ratio well defined near zero and is the most likely place for a sign or magnitude error.

---

## Every long training run has stalled, and each time for a different reason

Four separate causes have been found and fixed, and it is worth listing them together because they
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

Each was invisible in the fitness column and obvious in a different one — ties in the sample spread,
the reset in the centre-to-elite distance, the farmed reward in the on-track fraction, the moving
record in a re-measurement.

**The lesson worth keeping:** when a training curve flattens, the fitness number is the least
informative column in the log.
