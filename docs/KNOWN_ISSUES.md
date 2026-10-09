# Known issues

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
