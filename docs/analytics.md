# The Analytics page

The app has two pages. **Simulation** is the ward and the hospital. **Analytics** shows what the project has built and measured: the pipeline, the models, the evaluations, the simulator's own checks, the registry and the research agent's record. One switch at the top moves between them.

Open it at `#analytics`. It needs no sign-in.

Everything on it is synthetic and not validated. Every section says so.

## What it reads

Only files committed in this repository, under `src/data/evaluation/`. The page makes no network call and holds no token.

The files are copies. Their source is the BioSentry-Intelligence repository. A data contract kept by the two teams (`contract-evaluation`) says what each file holds.

| Section | Files |
|---|---|
| Pipeline | `pipeline.json` |
| Models | the model files the other repository commits: the manifest, the policies, the calibration files, the student's metadata, the run logs |
| Evaluations | `evaluations.json` (rules and the confidence check), the reward policy files and run log, the agent's run log |
| Simulator | `simulator.json`: the realism table, a many-seed compare, and the outcome model |
| Registry | `registry.json` and the manifest |
| Research agent | `research-agent.json` |

A file that is not in the source repository yet shows as `not on main yet`. So does a file the page cannot accept: wrong format, too large, a field out of shape, text with control or invisible characters or digits that are not 0 to 9, or outcome wording outside the labelled outcome block.

Each section prints where its files came from: the repository, the commit and the date. An old copy is visible as old.

## Rules the page keeps

- **No number is typed by hand.** Every number on screen is in the section's files. A test fails if the page shows a number that appears nowhere in that section's files.
- **Numbers print as the file writes them.** The page does no arithmetic on a number and no rounding. A curve of more than 200 points keeps every k-th point and the last, and says `curve thinned`.
- **Text only.** Nothing from a file becomes markup, a link or a style.
- **The outcome model keeps its label.** Its figures appear only under the line `MODEL ASSUMPTION, not evidence about patients`, on every table, with the alert cost beside them.
- **An `UNEXPECTED` realism row is shown,** never dropped. No table is cut short.
- **The confidence check shows its verdict word as written** (`MET` or `NOT MET`), with its cost in the same block. It is never worded as a guarantee.
- **One bad file cannot break the page,** and nothing here can break the Simulation page: the Analytics code is loaded only when the page is opened.

## Bring the copies up to date

```bash
npm run sync:evaluation -- <path to a BioSentry-Intelligence checkout>
```

The script reads that checkout's `origin/main` through git only (`remote get-url`, `rev-parse`, `log`, `ls-tree`, `show`). It never fetches, checks out or writes there. It copies a fixed list of files byte for byte and writes `src/data/evaluation/sync.json`: the source commit, its date, and each file's size and sha256.

It refuses, and writes nothing, when an exported file has the wrong `format` or `section` or is over 256 KB, when any file is not UTF-8 JSON, or when a folder holds more than five run logs. A direct file over 256 KB is skipped with a warning and its old copy removed, so the page shows `not on main yet`. The page checks each direct file's shape. The script also deletes any other `.json` under `src/data/evaluation/` that is not in the new set.

Run `git fetch` in that checkout yourself first if you want the newest main. Then commit the changed copies with `sync.json`. A test checks every copy against `sync.json`.

## Limits

- The copies are as old as the last sync. Nothing updates them on its own.
- Sections fill in as the other repository commits their files. Until then they say `not on main yet`.
- Every number prints exactly as written when the browser can read a JSON number's source text. An older browser prints the same value in its shortest form (`4` for `4.0`, `1` for `1.0`).
- The page describes a simulator and models trained on synthetic data. It is not evidence about patients or about a real ward.
