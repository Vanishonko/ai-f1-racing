# Known issues

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
