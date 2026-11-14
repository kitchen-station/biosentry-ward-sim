# Hospital vitals engine

Synthetic data only. Code: `src/sim/hospital/vitals.ts`. The standalone hospital page uses it, as described under "On the page" below.

## What it is
One vital-sign stream for each hospital person, kept beside the hospital. It uses the ward's own generator and `scoreNews2`. Each person gets a new generator of their own, seeded by `vitals:${id}:v${visit}`. A person is read once per simulated minute, on their own second (`n % 60`).

It is read-only. It reads `h.seed`, `h.lastMinute` and `h.people`. It writes only its own objects. It draws from no existing random stream. A seeded run with the engine fed every step is byte-identical to a run without it: the whole `Sim`, ward W4's saved source state and the hospital trial's files. Tests check each for one seed and one day: the `Sim`, W4's source and the trial's files. A review run repeated it for three seeds over three days.

It is display only. A score here never changes care, a move, a staff task or any hospital number.

## Labels by unit
These are the plan's Appendix table 1 texts.

| Unit | NEWS2 | Label |
|---|---|---|
| W4 | ranked (W4's own record) | Synthetic. Generator fitted to ICU data at ward-like baselines. |
| MED3A, MED3B | ranked | Synthetic. Same generator as W4. |
| SURG5A | ranked | Synthetic. Adult generator, not fitted to surgical patients. |
| ER | ranked | Synthetic. Not ER data: ward generator. |
| ICU | not ranked: "Not ranked: NEWS2 is a ward score." | Synthetic. ICU vitals are not modelled: ward generator values. |
| Morgue | none | none |

No unit has a shifted baseline. Age, sex and group change no vital: the generator ignores them.

## Stated defaults
- Consciousness (ACVPU) is "A" for everyone, as the generator's admit sets it. Not modelled.
- Oxygen is the generator's own draw and off-time (W4's rates). It is not the hospital's.
- Blood pressure is the arrival cuff, then a new cuff at each observation round the hospital records. No rounds in the ICU. In the ICU a person keeps the last cuff taken before they arrived (the arrival cuff if they had no round).
- SpO2 scale is 1 for everyone, as the generator's admit sets it.

## Deterioration and recovery
- An episode starts when the hospital records `course.onsetMin` for the person. The engine calls the generator's `inject` at that minute.
- A person with no recorded onset has no episode. If the generator drew one at admission, it is cleared when the stream opens: the source is rebuilt from its saved state with the inject time cleared. Readings before that time are unchanged.
- The generator has no recovery. When the hospital moves a person out of the ICU, the episode is cleared the same way and the span is marked `recovery: "not_modelled"`. One constant, `CLEAR_EPISODE_AT_ICU_STEP_DOWN` (now `true`), switches this. `createVitals({ clearEpisodeAtIcuStepDown })` overrides it for a test.
- While a person is on W4 the engine reads nothing and keeps a span with their W4 patient id. Reading restarts at the minute after the person leaves W4, with the same stream and an empty gate window. No W4 values are used.
- A W4 resident who never left W4 has no stream.

## Caps
`CAPS = { bins: 800, scores: 200, finished: 100, catchUpMin: 60 }`.
- At most 800 bins (200 hours, one every 15 minutes) and 200 hourly scores per person.
- At most 100 finished records. Live streams are at most the hospital's people.
- Catch-up is at most 60 minutes per person per call. A longer jump is not caught up: the engine leaves a span marked `gap: "not_read"` and reads from now.
- Spans are not capped: one is added at each change of unit, and two at each skipped gap.

## Cost
This build, one simulated day, seed 101: 245 ms without the engine, 1272 ms with it (one run on a shared machine).
The evaluator's worst single call was 13.9 to 14.5 ms, in the first second, when every stream opens with its warm-up. It fits in one 16.7 ms frame on its own.
The contract's prototype measured 0.43 s without and 2.38 s with the engine on a loaded machine, about 12-13 microseconds per read and 1.35 ms per simulated minute. Those are the prototype's numbers, not this build's.

## On the page
Only the standalone hospital build makes the engine. A viewer build, a watcher and the ward-only build never do, and no request is added. It is made with the world and replaced on every restart (scenario change, Shuffle, Reset). It is fed with `feedVitals` right after each `step` in the frame loop and in the chunked day skip, next to the ward-stats feed. It is display only.
- **First day.** Everyone present at minute 0 opens as a new admission. For about the first simulated day roughly 4 in 10 are on oxygen (W4's admitted patients run near 15%) and NEWS2 5 or more is about twice W4's share. It settles after about a day. Measured in a review run, seed 101, `typical`:

| Simulated time | Share at NEWS2 5 or more |
|---|---|
| 6 h | 32% |
| 12 h | 27% |
| 24 h | 15% |
| after 24 h | 10 to 20% |
| W4, admitted patients | 11 to 12% |

  The unit and person panels say so while the hospital clock is under 24 hours from the run's start: "First day: everyone starts as a new admission, so scores run high."
- **Canvas.** Beds and tags outside W4 take the NEWS2 risk colour of their person, from `riskBySel`. Grey means not ranked. Ward W4's drawing is unchanged. Intensive care keeps its group colours: no NEWS2 colour. The ER waiting room keeps its triage colours.
- **Unit panels** (MED3A, MED3B, SURG5A, the ER queue panel, ICU). The unit's label, then the ranked list in the ward's own order (rank, name, bed or stretcher, NEWS2 total, the mini vitals line), then the people not ranked and why. The ER list includes the waiting room. Intensive care lists its people with their vitals and the line "Not ranked: NEWS2 is a ward score." Every one of them also says "Display only. Care in the model does not read this score."
- **Person panel** for someone outside W4. The unit label, the NEWS2 total and risk word (in intensive care, the ward-score line), the same five vital cards as W4's patient panel, and one line of inputs: consciousness alert (not modelled), oxygen the generator's draw, blood pressure at arrival and each round (arrival only in intensive care). A person whose episode was cleared at an intensive care step-down shows "Simulated recovery, not modelled."
- **W4's own panels** are unchanged. The unit panel for W4 shows no label.
- **Legend.** "ICU: no NEWS2 colour. Waiting room: triage colour."
- **Entrance panel.** Its "Skip 1 day" button is hidden in a hospital world, because that jump steps with no feed. The top bar's "+1 day" stays and is fed.

## Hourly counts for the Analytics page
`HospitalVitals.hourly` holds one row per unit (ER, MED3A, MED3B, SURG5A, ICU) per hour: people read, by NEWS2 level (`low`, `low_medium`, `medium`, `high`, `not_ranked`) and `read`. Intensive care rows hold `read` only. A row is added when the hour starts (zeros, so an empty unit is 0, not a gap) and filled when a person's hourly score is taken. At most 840 rows are kept (`CAPS.hourRows`, 168 hours). `pageView(v)` returns `created`, `reads` and a copy of the rows. It is pure, draws no random number and does not touch `summary()` or its digest. The page must not call `summary()`: it stringifies every bin.

## One person across moves
Code: `src/person-timeline.tsx`. The person panel (outside W4) shows "Whole stay" under the path:
- A strip of unit bands from the engine's spans, each with the unit's id. Below it, small line charts for heart rate, respiratory rate, SpO2, temperature, systolic pressure and NEWS2 on a 15-minute grid. Each chart scales to its own data. NEWS2 is blank in intensive-care bands: "NEWS2 is a ward score".
- Where the person was on ward W4 the engine read nothing. The band says "Ward W4: own record." and has a button "Open the W4 stay" that opens W4's own stay panel. The next band says "New values from here: not continued from W4." If that stay has left the record (W4 keeps the last 500 stays), the panel says so.
- A gap the engine did not read is a band labelled "Not read (skipped)." A band after an intensive-care step-down shows "Simulated recovery, not modelled."
- At 800 bins the view says "Last 200 h".

Each unit panel (and the ER queue panel) shows "Moves today: N" and the 10 newest rows as `clock · name · text`. For a ward or the ICU, a move is a `place`, `transfer`, `discharge`, `died` or `transfer_out` row at that unit, plus a `transfer` whose detail starts "<unit> to ". A person admitted from the ER is a `place` row at the ward, so the ward counts it once. For the ER, N is every way a person left it today: placed in a unit (every `place` row comes from the ER), sent home (`decide_home`), left unseen (`lwbs`), transferred out, died. One short line under it gives the parts, for example "Placed in a unit 16 · home 12 · left unseen 3". The rows are the hospital's event rows, capped at 5000. The panel says so when older rows may be gone. The ICU panel adds one line with its bed count read from the hospital: "In this model a person leaves the ICU only by stepping down to a ward or by dying." (`step.ts` never discharges an ICU person home.)

Measured moves per day in the design plan's Appendix table 3 (seven-day `hospital-trial` runs, typical, seed 101): 2.6 between units, 5.6 stretcher to bed, 15.9 discharges.

## Not claimed
No outcome claim. A NEWS2 colour outside W4 is a display of a synthetic score. It is not a finding about any real ward.
