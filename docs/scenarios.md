# Named scenarios, Shuffle and the seed

This is the standalone page only. A viewer build and the ward-only build do not have it.

## The named scenarios

The top bar's scenario select lists these. Each sets a scenario file, a hospital seed and a vitals seed.

| Name | Id | File | Seeds |
|---|---|---|---|
| Pitch ward (default) | `pitch` | `typical.json` | hospital 101, vitals 20260903 |
| Calm, fully staffed | `calm` | `doh-standard.json` | hospital 101, vitals 20260903 |
| Surge | `surge` | `surge.json` | hospital 101, vitals 20260903 |
| More ward nurses (DOH ward staffing) | `more-nurses` | `more-nurses.json` | hospital 101, vitals 20260903 |
| Critical group | `critical` | `typical.json` | hospital 101, vitals 20261114 |

- Pitch ward is the run the page opened on before this list existed. It is the same world, step for step.
- Calm uses the DOH staffing standard and fewer arrivals than typical. Surge has more arrivals than typical and the same staff. The numbers are in the files.
- `more-nurses.json` is `typical.json` with one kind of change: the ward nurse counts (MED3A, MED3B and SURG5A, three fields) are the values `doh-standard.json` uses. Choosing those values is a judgement. ICU and ER staffing are unchanged. Its `name` and `note` text also differ. It is made for `npm run compare` and `npm run hospital-trial`, which read it like any scenario file.

## Critical group

- A chosen demonstration group, not a ward rate: 4 of ward W4's 12 starting patients are made to start a simulated deterioration in the first 6 hours. The 4 and the 6 hours are chosen values, with no source. Another of the 12 can start one of its own by chance in those hours (in 7 of seeds 1 to 200), so the screen says "others may start one by chance".
- It always draws the 12 (also with no seed in the address). The pick uses its own stream, `critical`, so with one seed the 12 people are the same as under "Pitch ward" with that seed. Only patients due to leave after minute 360 can be picked.
- Each picked patient gets `inject` at a minute from 0 to 359, the same call the page's "Start deterioration" button makes. That button can still move a picked patient's start earlier.
- Limit: if fewer than 4 of the 12 are due after 6 hours, fewer are picked. The simulation log's first line holds the real count; the page does not show that line (it shows log lines only in a machine's panel). The scenario's hover sentence always says 4. In seeds 1 to 20000 the count was never under 4. A drawn patient may also have a deterioration of its own scheduled (see below), and that is not counted.
- The seed pill reads `Seed 101 / 20261114 · chosen group`, or `Seed 777 · chosen group` with a seed.

## The seed pill

The pill next to the select shows the seed. The pill of "Critical group" ends with ` · chosen group`. A named scenario with its own seeds shows the hospital seed and, when it differs, the vitals seed, for example `Seed 101 / 20260903`. After Shuffle, or with `seed` in the address, it shows that one number, which is used for both seeds and draws ward W4's 12 starting patients. It is text, not an input.

## Shuffle

Shuffle draws a whole number from 1 to 2147483647 with `crypto.getRandomValues`, and restarts the world with the current scenario file and that number as both the hospital seed and the vitals seed. The simulation's own random streams are not touched.

A shuffled seed draws 12 new ward W4 patients. The same seed gives the same 12 people, so a copied address repeats them. The named scenarios with no seed show the same 12 fixture patients as before, except "Critical group", which always draws.

How the 12 are drawn: each one is drawn by the same code that draws an arriving patient (sex, bed, case, stay, baseline vitals, rhythm, name and age), from random streams of their own named `cohort:1` to `cohort:12`. They never use the arrival stream, so with one seed the arrivals after minute 0 are the same whether the 12 are drawn or fixture. Their ids are `c-001` to `c-012`. They are seated at minute 0 part-way through a stay, like the fixture 12. Their story line says they are synthetic patients drawn for this run. They have no invented history.

Limits.

- A drawn group never repeats a full name: a repeat gets a new name (only the name) from its own stream `cohort:i:name`. An arriving patient can still share a name with one of the 12.
- A drawn patient is drawn exactly as an arriving patient is, so about 6 in 100 have a simulated deterioration scheduled (the arrivals' rate), never before minute 0; about half of those start before the patient leaves. The Analytics page's episode table does not list them, because it leaves out stays that were already on the ward at the start, as the compare runner does.
- A drawn patient's oxygen and discharge time are not linked: oxygen is drawn at the arrivals' rate and comes off at 32% of the patient's own drawn stay, counted from minute 0. The due time comes from the ward's rule for patients already present, as for the hand-written 12 (whose oxygen is fixed from the fixture and never comes off).
- A restored source whose saved state holds no fixture id refuses `seeds()` (it throws). That covers a drawn world, and also a fixture ward saved after its 12 have all left. Nothing calls `seeds()` on a restored source.
- The runner, the trial runners, the compare runner and the viewer always use the fixture 12; only the standalone page draws.

## Repeat a run by URL

The page reads `?scenario=<id>&seed=<n>` on load.

- A known `scenario` id selects that scenario. Anything else gives `pitch`.
- `seed` must be digits only, from 1 to 2147483647. It then replaces both seeds and draws ward W4's 12 starting patients from it. Anything else is ignored (`12abc`, `1e3`, `-5`, a leading space, an empty value, a number that is too large).
- Choosing a scenario or pressing Shuffle updates the address with `history.replaceState`. The page does not reload. The hash (`#analytics`) and other parameters (`?perf`) are kept.

`?scenario=pitch&seed=777` now means a drawn group of 12 for seed 777. This is a change from the previous build of this branch, where it kept the 12 fixture patients with seed 777. That address form has never been on main.

To repeat a run, copy the address bar. The same scenario and seed give the same run in the same build. A choice of scenario keeps the seed. With `more-nurses` against `pitch` and one seed, the people and the arrivals are the same and only the ward nurse counts differ. Calm and surge change who is in the hospital at the start or who arrives. After a Shuffle, the way back to a scenario's own seeds is to remove `seed` from the address.

The Analytics page restarts with the world on every scenario change, Shuffle and start.
