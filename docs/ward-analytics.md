# Ward analytics

The Analytics page is a second view in the customer app. It sits beside the simulation in the top bar: "Simulation" (`#simulation`) and "Analytics" (`#analytics`). The URL hash picks the view. The top bar stays on both.

Everything is synthetic. The patients are simulated. The page makes no outcome claim. This is not the developer page: that is a separate build (see [analytics.md](analytics.md)).

## What it shows

Charts first, short labels, one line of text under each chart.

Hospital (standalone hospital world only)
- Beds in use: per unit, per hour, census against beds, grouped by floor.
- In and out: per unit, per day, admitted, discharged, transferred in, transferred out. The ER also shows arrivals. The page draws these counts and prints no sums.

Ward W4 (NEWS2 exists on W4 only)
- NEWS2 levels: patients at each level per hour, with "not ranked" kept apart. The levels are the ones in `src/sim/news2.ts`.
- Alerts per patient per shift: one bar per 12 h shift, shifts start at 07:00 and 19:00. A part shift is faded.
- Beds in use: occupied beds per hour.
- Length of stay: one dot per finished stay, coloured by outcome. A stay that began before the run (`inMin` 0) is left out.

Person (pick one)
- NEWS2 by hour: the stay's hourly scores.
- What happened: the stay's last 30 event lines.
- Vitals, last 3 h: heart rate, respiratory rate, SpO2 and temperature in 15-minute bins.

## Where the data comes from

The ward builds a summary while it runs: `src/sim/ward-stats.ts`. It is pure. It only reads the simulation, calls no random stream and writes nothing on the `Sim`. A test shows a run that is fed ends in the same state as one that is not. It is made with the world, replaced on reset or on a scenario change, and fed after every `step()`, in the frame loop and in the day skip. It is not in `Sim`, so saves and the golden run are unchanged. `src/headless.ts` does not use it.

- Every 15 minutes a bin closes. It is read in two parts, because the last patient is sampled 95 s after the minute and a patient may leave before that. If a jump went past the bin, it is not made up.
- The summary keeps at most 672 bins (7 days), 14 shifts, 200 finished stays and 168 hours for each hospital unit.
- Person charts read the patients the page was given: `Stay.scores`, `Stay.events` and `Patient.history`.
- The page prints no number that is not in the data it was given. The tests check this.

## Alerts

An alert here is the demo line: NEWS2 total 5 or more, with the compare runner's re-arm rule (`news2_total_ge_5`). After an alert a patient can alert again only after 16 quiet 15-minute bins (4 h). A missing bin counts as quiet. `REARM_BINS` is defined in `ward-stats.ts` and `src/compare.ts` imports it. A test checks the count equals the compare runner's on the same seeded run. It is a demo line, not a clinical threshold.

## Skipped spans

If the clock jumps and the page is not fed (the "Skip 1 day" button in the ward-only build), the bins in that span are not recorded. The charts draw a hatched gap labelled "skipped".

## Where the page runs

- Hospital world: all sections.
- Ward-only standalone build: the Hospital section is one line, "This page simulates ward W4 only."
- Viewer build, signed in: the page does not run its own simulation and never shows its own world's numbers. The Hospital and Ward charts each say "Not available from the runner yet", because the runner sends no totals. The Person charts use the patient views the page already has from its `/live` reads. The page adds no request of its own.
- Viewer build, watching with no token: only "Sign in to see ward analytics" and the "Sign in to control" button. No request is made.

## Page and run

The Analytics view is drawn inside the ward component. The ward is hidden, not removed, so a standalone run keeps stepping and keeps its history while you look at the page. Going back shows the same run. The page code loads only when the view is first opened, as a separate chunk. Its text is React text: nothing from data goes in a link, a style or a class name.

## Not in version 1

Simulated episodes, staff time away from base, late recognition and vitals against the person's own start are not shown. `episodes` and `staff` in the summary are `null`.
