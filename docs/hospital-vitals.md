# Hospital vitals engine

Synthetic data only. Code: `src/sim/hospital/vitals.ts`. Nothing on the page uses it yet. The page wiring is a later slice.

## What it is
One vital-sign stream for each hospital person, kept beside the hospital. It uses the ward's own generator and `scoreNews2`. Each person gets a new generator of their own, seeded by `vitals:${id}:v${visit}`. A person is read once per simulated minute, on their own second (`n % 60`).

It is read-only. It reads `h.seed`, `h.lastMinute` and `h.people`. It writes only its own objects. It draws from no existing random stream. A seeded run with the engine fed every step is byte-identical to a run without it: the whole `Sim`, ward W4's saved source state and the hospital trial's files. Tests prove each.

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
- Blood pressure is the arrival cuff, then a new cuff at each observation round the hospital records. No rounds in the ICU.
- SpO2 scale is 1 for everyone, as the generator's admit sets it.

## Deterioration and recovery
- An episode starts when the hospital records `course.onsetMin` for the person. The engine calls the generator's `inject` at that minute.
- A person with no recorded onset has no episode. If the generator drew one at admission, it is cleared when the stream opens: the source is rebuilt from its saved state with the inject time cleared. Readings before that time are unchanged.
- The generator has no recovery. When the hospital moves a person out of the ICU, the episode is cleared the same way and the span is marked `recovery: "not_modelled"`. One constant, `CLEAR_EPISODE_AT_ICU_STEP_DOWN` (now `true`), switches this. `createVitals({ clearEpisodeAtIcuStepDown })` overrides it for a test.
- While a person is on W4 the engine reads nothing and keeps a span with their W4 patient id. Reading restarts at the current minute with the same stream. No W4 values are used.
- A W4 resident who never left W4 has no stream.

## Caps
`CAPS = { bins: 800, scores: 200, finished: 100, catchUpMin: 60 }`.
- At most 800 bins (200 hours, one every 15 minutes) and 200 hourly scores per person.
- At most 100 finished records. Live streams are at most the hospital's people.
- Catch-up is at most 60 minutes per person per call. A longer jump is not caught up: the engine leaves a span marked `gap: "not_read"` and reads from now.
- Spans are not capped: one is added only on a move or a skipped gap.

## Cost
The contract's prototype measurement, on a loaded machine, one simulated day, seed 101: hospital step alone 0.43 s; with the engine 2.38 s; about 12-13 microseconds per read; 1.35 ms per simulated minute. The first minute opens about 106 streams in one 22 ms step. These are the prototype's numbers, not this build's.

## Not claimed
No outcome claim. Nothing here has been shown on a page.
