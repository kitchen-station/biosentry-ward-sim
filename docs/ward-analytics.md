# Ward analytics

The Analytics page is a second view in the customer app. It sits beside the simulation in the top bar: "Simulation" (`#simulation`) and "Analytics" (`#analytics`). The URL hash picks the view. The top bar stays on both.

Everything is synthetic. The patients are simulated. The page makes no outcome claim. This is not the developer page: that is a separate build (see [analytics.md](analytics.md)).

## What it shows

Charts first, short labels, one line of text under each chart.

Hospital (standalone hospital world only)
- Beds in use: per unit, per hour, census against beds, grouped by floor. The morgue is labelled in places, not beds.
- In and out: per unit, per day, admitted, discharged, transferred in, transferred out. The ER also shows arrivals. The page draws these counts and prints no sums.

Ward W4 (NEWS2 exists on W4 only)
- NEWS2 levels: patients at each level in the bin read at each whole hour, with "not ranked" kept apart. The levels are the ones in `src/sim/news2.ts`.
- Alerts per patient per shift: one bar per 12 h shift, shifts start at 07:00 and 19:00. A part shift is faded.
- Beds in use: patients read in the bin at each whole hour.
- Length of stay: one dot per finished stay, coloured by how the stay ended. A stay that began before the run (`inMin` 0) is left out. With none yet it says "No finished stay yet (stays that began before the run are not counted)".
- Simulated episodes: a table under these charts, from the simulator's own truth. See Simulated episodes below.

Person (pick one)
- NEWS2 by hour: the stay's hourly scores.
- What happened: the stay's last 30 event lines.
- Vitals, last 3 h: heart rate, respiratory rate, SpO2 and temperature in 15-minute bins. Values print as the ward's vital cards print them (same digits and units), and each line is scaled to its own range.

## Where the data comes from

The ward builds a summary while it runs: `src/sim/ward-stats.ts`. It is pure. It only reads the simulation, calls no random stream and writes nothing on the `Sim`. A test shows a run that is fed ends in the same state as one that is not. It is made with the world, replaced on reset or on a scenario change, and fed after every `step()` in the frame loop and in the hospital world's +1 day. The Entrance panel's Skip 1 day is not fed, and its span shows as skipped. It is not in `Sim`, so saves and the golden run are unchanged. `src/headless.ts` does not use it.

- Every 15 minutes a bin closes. Each patient is read on the tick after its own sample for the bin minute, as the trial runner reads it, and the bin closes after the sampling window (60 s plus 5 s per bed). A patient placed after the bin minute is not counted. If a jump went past the bin, it is not made up.
- The summary keeps at most 672 bins (7 days), 14 shifts, 200 finished stays and 168 hours for each hospital unit.
- Person charts read the patients the page was given: `Stay.scores`, `Stay.events` and `Patient.history`.
- The page prints no number that is not in the data it was given. The tests check this.

## Alerts

An alert here is the demo line: NEWS2 total 5 or more, with the compare runner's re-arm rule (`news2_total_ge_5`). After an alert a patient can alert again only after 16 quiet 15-minute bins (4 h). A missing bin counts as quiet. `REARM_BINS` is defined in `ward-stats.ts` and `src/compare.ts` imports it. A test checks the count equals the compare runner's on the same seeded run. It is a demo line, not a clinical threshold.

## Simulated episodes

Owner decision `sim-lab-4`: the page lists each simulated deterioration episode, with no outcome. Under the Ward W4 charts, a table "Simulated episodes" has one row per episode, newest first: Start, Kind, First alert and Minutes between. Above it: "Simulated episode, the simulator's ground truth. A real ward never knows this. No outcome shown."

- Where it comes from: the simulator's own saved truth for each patient (`injectAt`, the episode kind and `rampMin`, which stays inside the accumulator), read once per 15-minute bin, as `src/sim/trial.ts` reads it for `episodes.csv`. A real ward never has it.
- A start is recorded and shown only after the clock has reached it. A scheduled start in the future is never shown.
- Which episodes: the compare runner's set. The stay began after minute 0, and the start is inside the stay.
- Window: start to fully in (start plus ramp), plus 120 min (`WINDOW_AFTER_FULL_MIN`, shared with `src/compare.ts`). First alert is the first new alert of that patient in the window, by the alert rule below. If none came, the row says "none in the window", or "window still open" while it can still come. An alert that was already active before the start is not new, as in compare, so Minutes between is never negative. Minutes between is rounded to a whole minute.
- The summary entry holds only `start`, `kind`, `alertMin`, `minutesBetween` and `windowOpen`. It holds no ramp length, no end of window and no patient id, so nothing in it is ahead of the clock. `windowOpen` turns false when the window ends, which shows the ramp length only after the fact. A test checks the keys and that no minute is ahead of the clock after every bin.
- Known limit: an episode whose patient leaves before the next 15-minute bin closes is not listed. In seeds 1 to 40 over 7 days this did not happen (38 evaluated episodes, none missed).
- It is the simulator's own knowledge. No outcome is shown, and the page prints no summary figure for the column.
- Caps: 200 episodes kept (oldest dropped), the newest 50 shown with "Showing the newest 50 of N". A patient's episode stays after the patient leaves.
- With no source that can save, `episodes` is `null` and the page says "Not available here." The viewer build shows no table.

## Skipped spans

If the clock jumps and the page is not fed (the Entrance panel's Skip 1 day), the bins in that span are not recorded. The charts draw a hatched gap labelled "skipped".

## Where the page runs

- Hospital world: all sections.
- Ward-only standalone build: the Hospital section is one line, "This page simulates ward W4 only."
- Viewer build, signed in: the page does not run its own simulation and never shows its own world's numbers. The Hospital section is one line, "The runner runs ward W4 only." The Ward charts each say "Not available from the runner yet", because the runner sends no totals. The Person charts use the patient views the page already has from its `/live` reads. The page adds no request; the open view's poll continues as before.
- Viewer build, watching with no token: only "Sign in to see ward analytics" and the "Sign in to control" button. No request is made.

## Page and run

The Analytics view is drawn inside the ward component. The ward is hidden, not removed, so a standalone run keeps stepping and keeps its history while you look at the page. Going back shows the same run. The page code loads only when the view is first opened, as a separate chunk. Its text is React text: nothing from data goes in a link, a style or a class name. If the page fails to load or a chart throws, only the Analytics view shows "Could not show analytics" and the ward keeps running; switching to Simulation and back tries again. Numbers that are not finite are dropped from the drawing, and a summary with missing arrays shows "No data yet".

## Not in version 1

Staff time away from base, late recognition and vitals against the person's own start are not shown. `staff` in the summary is `null`.
