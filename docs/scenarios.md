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

- Pitch ward is the run the page opened on before this list existed. It is the same world, step for step.
- Calm uses the DOH staffing standard and fewer arrivals than typical. Surge has more arrivals than typical and the same staff. The numbers are in the files.
- `more-nurses.json` is `typical.json` with one kind of change: the ward nurse counts (MED3A, MED3B and SURG5A, three fields) are the values `doh-standard.json` uses. Choosing those values is a judgement. ICU and ER staffing are unchanged. Its `name` and `note` text also differ. It is made for `npm run compare` and `npm run hospital-trial`, which read it like any scenario file.

## The seed pill

The pill next to the select shows the seed. A named scenario with its own seeds shows the hospital seed and, when it differs, the vitals seed, for example `Seed 101 / 20260903`. After Shuffle, or with `seed` in the address, it shows that one number, which is used for both seeds. It is text, not an input.

## Shuffle

Shuffle draws a whole number from 1 to 2147483647 with `crypto.getRandomValues`, and restarts the world with the current scenario file and that number as both the hospital seed and the vitals seed. The simulation's own random streams are not touched.

Limit: ward W4's first 12 patients are the same people under every seed. A shuffle changes their noise, how long they stay and who arrives later. It does not draw new W4 patients.

## Repeat a run by URL

The page reads `?scenario=<id>&seed=<n>` on load.

- A known `scenario` id selects that scenario. Anything else gives `pitch`.
- `seed` must be digits only, from 1 to 2147483647. It then replaces both seeds. Anything else is ignored (`12abc`, `1e3`, `-5`, a leading space, an empty value, a number that is too large).
- Choosing a scenario or pressing Shuffle updates the address with `history.replaceState`. The page does not reload. The hash (`#analytics`) and other parameters (`?perf`) are kept.

To repeat a run, copy the address bar. The same scenario and seed give the same run in the same build. A choice of scenario keeps the seed. With `more-nurses` against `pitch` the people and the arrivals are the same and only the ward nurse counts differ. Calm and surge change who is in the hospital at the start or who arrives. After a Shuffle, the way back to a scenario's own seeds is to remove `seed` from the address.

The Analytics page restarts with the world on every scenario change, Shuffle and start.
