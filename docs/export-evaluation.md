# Export for the developer page: `simulator.json`

The developer page (a separate build, see `docs/analytics.md`) has a Simulator section. Its data is one file, `simulator.json`. This command makes it.

The file holds three things: the realism table, one many-seed compare, and the outcome model's block when the compare was run with `--outcome-model`. Everything in it is synthetic. Its shape is set by the data contract the two teams keep (`contract-evaluation`, Section 4).

## Run it

First make the compare result. It takes many minutes:

```bash
npm run compare -- --seed 1 --seeds 20 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --outcome-model --out trials/compare-outcome
```

Then export. It runs the realism report itself, so it takes about three minutes:

```bash
npm run export:evaluation -- --compare trials/compare-outcome/compare.json --date 2026-11-13 --commit "$(git rev-parse HEAD)" --source "npm run compare -- --seed 1 --seeds 20 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --outcome-model --out trials/compare-outcome" --out trials/simulator.json
```

| Flag | Meaning |
|---|---|
| `--compare` | One `compare.json` made with `--seeds`. With `--outcome-model` it also carries the outcome block |
| `--date` | The date written into the file. The command reads no clock |
| `--commit` | The simulator commit, 40 lower-case hex characters. The command makes no git call |
| `--source` | The compare command line, exactly as it was run. It is checked against the compare file |
| `--out` | A file that does not exist yet. Its folder must exist |

Each flag is given once. The same inputs give the same bytes.

## What the file holds

- **Envelope:** `format` (`biosentry-evaluation/3`), `section` (`simulator`), and `provenance`: this repository, the commit, the date, the two commands, `synthetic: true`, `validated: false`, and the compare seeds. The realism checks use more seeds than the contract's list allows, so a note says they are not listed.
- **`body.realism`:** the rows of `npm run realism`, as text exactly as printed, and its footer lines. An `UNEXPECTED` row is written like any other.
- **`body.compare`:** the pooled figures, the spread across seeds, the paired figures and the notes of the compare file. Numbers are copied. The export never rounds.
- **`body.outcome`:** the compare file's `outcome_model` block, key for key, with its label `MODEL ASSUMPTION, not evidence about patients`, plus the seeds. It is `null` when the compare was run without `--outcome-model`.

`body.compare` and `body.outcome` always come from the same compare file.

## What it refuses

One line on stderr, exit 2, and nothing is written, when:

- a flag is missing, repeated or unknown; the date is not a real date; the commit is not 40 lower-case hex characters;
- `--source` is not a compare command line, has a flag compare does not know, a flag twice or no `--out`, or does not match the compare file (seed, seeds, days, rules, outcome flag);
- `--out` exists (a symlink that points nowhere counts), its parent folder does not exist, or its parent is not a folder;
- the compare file cannot be read, is not a regular file, or is over 1024 KB;
- the compare file is not a synthetic many-seed W4 compare of two rules (`compare_format` 1), lacks a key, has an unknown key, or holds a number that does not fit its kind (a whole number, or at most 4 decimals; both small enough to be exact);
- the outcome block's label is not the exact label;
- the outcome block's sensitivity rows are not zero, half, central, double, in that order;
- Node's major version differs from the one that made the compare file;
- a text or a list is over its cap in the contract (the export never cuts);
- a banned phrase or an absolute path is in the file or in `--source`;
- the file would be over 256 KB.

The checks on the flags, on `--source` and on the compare file run before the three-minute realism run. The realism caps and the 256 KB file cap run after it.

The number check works on the parsed value, not on the text. Compare writes its numbers in their shortest form, so the two are the same for any file compare wrote.

Any other error prints `export: failed: <message>` and exits 1; an error before the write leaves no file.

With an `UNEXPECTED` realism row the file is still written and the command exits 1, as `npm run realism` does. Hiding a drift would be worse than showing it.

## The realism table as JSON

```bash
npm run realism -- --json trials/realism.json
```

This prints the table as usual and also writes its rows and footer lines as JSON. With no argument `npm run realism` prints exactly what it printed before.

## Hand-over

This repository does not write to the BioSentry-Intelligence repository. The file is handed to the dashboard team with the command line as run, the simulator commit and the file's sha256. They commit it unchanged. The sync script (`npm run sync:evaluation`, see `docs/analytics.md`) then brings it back here with the other files.

Make the hand-over file at a commit that is on `main`, so the commit in the file can be found.
