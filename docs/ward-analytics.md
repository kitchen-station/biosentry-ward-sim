# Ward analytics

The Analytics page is a second view in the customer app. It sits beside the simulation in the top bar: "Simulation" (`#simulation`) and "Analytics" (`#analytics`). The URL hash picks the view. The top bar stays on both.

Everything is synthetic. The patients are simulated. The page makes no outcome claim. This is not the developer page: that is a separate build (see [analytics.md](analytics.md)).

## What it shows

Charts first, short labels, one line of text under each chart.

Hospital (standalone hospital world only)
- Beds in use: per unit, per hour, census against beds, grouped by floor. The morgue is labelled in places, not beds.
- In and out: per unit, per day, admitted, discharged, transferred in, transferred out. The ER also shows arrivals. The page draws these counts and prints no sums.

Every unit (standalone hospital world only; synthetic vitals, display only)
- NEWS2 levels, every unit: four small charts (ER, MED3A, MED3B, SURG5A), people at each level at each whole hour, drawn with the same chart pieces, level list and colours as W4's chart. Source: `pageView()` of the vitals engine (`src/sim/hospital/vitals.ts`), the capped table `hourly` (840 rows: 168 hours of 5 units, oldest dropped). Complete hours only: the hour still filling is not drawn. Under each chart is the unit's own label (`UNIT_LABEL`, shared in `src/hospital-labels.ts`); the ER adds "Includes the waiting room."
- Intensive care: people read at each whole hour: a line of the ICU rows. No NEWS2: it is a ward score, so ICU rows hold only the count read.
- One line: "Vital-sign streams opened outside ward W4: N (one per person per visit). Readings: M." Both numbers come from the engine as given.
- Display only: care in the model does not read any of it. While the run is under 24 hours the first-day note shows ("First day: everyone starts as a new admission, so scores run high."). Before the first complete hour the charts say "No data yet". A ward-only or viewer build shows none of this section.

Ward W4 (everything in this section is W4's own record)
- NEWS2 levels: patients at each level in the bin read at each whole hour, with "not ranked" kept apart. The levels are the ones in `src/sim/news2.ts`.
- Alerts per patient per shift: one bar per 12 h shift, shifts start at 07:00 and 19:00. A part shift is faded.
- Beds in use: patients read in the bin at each whole hour.
- Length of stay: one dot per finished stay, coloured by how the stay ended. A stay that began before the run (`inMin` 0) is left out. With none yet it says "No finished stay yet (stays that began before the run are not counted)".
- Simulated episodes: a table under these charts, from the simulator's own truth. See Simulated episodes below.

Person (pick one)
- NEWS2 by hour: the stay's hourly scores.
- What happened: the stay's last 30 event lines.
- Vitals, last 3 h: heart rate, respiratory rate, SpO2 and temperature in 15-minute bins. Values print as the ward's vital cards print them (same digits and units), and each line is scaled to its own range.

## How a vital is drawn

Code: `src/obs-bands.ts`, `ObsChart` in `src/insights/charts.tsx`. Tests: `src/obs-bands.test.tsx`.

From the Royal College of Physicians' NEWS2 observation chart (Chart 3, 2022, https://www.rcp.ac.uk/media/eczf5mvm/news2-chart-3_news-observation-chart_2022_0_0.pdf):

- One chart per vital, with its unit, in the chart's order: respirations (breaths/min), SpO2 scale 1 (%), systolic blood pressure (mmHg), pulse (beats/min), temperature (°C).
- Time runs left to right.
- The value axis is banded: each range is shaded by its NEWS2 score, with the chart's key (no colour for 0, yellow for 1, orange for 2, red for 3). The band limits are printed on the axis.
- The bands are the scorer's own (`src/sim/news2.ts`, unchanged). A test scores every value on every axis with the scorer and requires the same band.
- The NEWS2 total has its own chart: orange from 5 (medium), red from 7 (high).

Ours, not the RCP's (no published rule was found for these; they are design choices of this page):

- The axis of each vital is fixed (for example respirations 4 to 36), so small noise never fills the chart and two charts of one vital can be compared. A value off the axis is drawn hollow on its edge.
- A dot at every reading; a line only between readings that follow each other. A missing reading is a gap and is never bridged.
- The last value is printed on the chart. The left end and the middle are labelled by how long ago they were.
- A limit's number is printed only where it has room; every limit still has its mark.
- SpO2 is drawn on scale 1 only.
- Count charts (beds in use, people read) have a numbered axis from 0, name what they count and print the last value. They no longer zoom to their own range.
- Bar charts (in and out, NEWS2 levels, alerts per shift) number their axis: 0 and the tallest bar, with what the height counts. The alerts chart names its rule on the chart: "alert = NEWS2 5 or more". Length of stay has its ends labelled in days.
- A stay's score line prints "last, low, high" and how many hourly scores it holds.
- The heart trace is drawn from the heart rate. It says "Illustration, not a recording" on the strip itself.

## Which panel reads what

| Panel | The developer's page (its own engine) | Signed in, watching the server |
|---|---|---|
| Hospital: beds in use, in and out | the engine's hourly rows | **not served** (one line says so) |
| Every unit: NEWS2 levels, intensive care | the vitals engine | not shown |
| Ward W4: NEWS2 levels, alerts per shift, beds in use, length of stay | the page's own statistics | **not served** (each chart says so) |
| Simulated episodes | the simulator's truth | not shown |
| Person: NEWS2 by hour, what happened, vitals | the page's patients | **served**: the patient views of the live view |

No panel shows the browser engine's numbers while the page watches the server. The page says "Not served", never "No data yet", when the server does not send a number: "No data yet" is for a run that has not produced it yet. What the server would have to serve for the middle rows: per unit and hour, beds in use, admitted, discharged, transferred in and out, and the count at each NEWS2 level; per 12-hour shift, alerts and patient-minutes; and finished stays with their in and out minutes.

## Where the data comes from

The ward builds a summary while it runs: `src/sim/ward-stats.ts`. It is pure. It only reads the simulation, calls no random stream and writes nothing on the `Sim`. A test shows a run that is fed ends in the same state as one that is not. It is made with the world, replaced on reset or on a scenario change, and fed after every `step()` in the frame loop and in the hospital world's +1 day. The Entrance panel's Skip 1 day is not fed, and its span shows as skipped. It is not in `Sim`, so saves and the golden run are unchanged. `src/headless.ts` does not use it.

- Every 15 minutes a bin closes. Each patient is read on the tick after its own sample for the bin minute, as the trial runner reads it, and the bin closes after the sampling window (60 s plus 5 s per bed). A patient placed after the bin minute is not counted. If a jump went past the bin, it is not made up.
- The summary keeps at most 672 bins (7 days), 14 shifts, 200 finished stays and 168 hours for each hospital unit.
- Person charts read the patients the page was given: `Stay.scores`, `Stay.events` and `Patient.history`.
- The page prints no number that is not in the data it was given. The tests check this.

## Alerts

An alert here is this page's own alert line: NEWS2 total 5 or more, with the compare runner's re-arm rule (`news2_total_ge_5`). After an alert a patient can alert again only after 16 quiet 15-minute bins (4 h). A missing bin counts as quiet. `REARM_BINS` is defined in `ward-stats.ts` and `src/compare.ts` imports it. A test checks the count equals the compare runner's on the same seeded run. It is a demo line, not a clinical threshold.

## Simulated episodes

Owner decision `sim-lab-4`: the page lists each simulated deterioration episode, with no outcome. Under the Ward W4 charts, a table "Simulated episodes" has one row per episode, newest first: Start, Kind, First alert and Minutes between. Above it: "Simulated episode, the simulator's ground truth. A real ward never knows this. No outcome shown."

- Where it comes from: the simulator's own saved truth for each patient (`injectAt`, the episode kind and `rampMin`, which stays inside the accumulator), read once per 15-minute bin, as `src/sim/trial.ts` reads it for `episodes.csv`. A real ward never has it.
- A start is recorded and shown only after the clock has reached it. A scheduled start in the future is never shown.
- Which episodes: every episode whose start is inside the stay. That is the compare runner's set, plus patients who were on the ward at minute 0, which compare leaves out. The hand-written 12 have no episode unless "Start deterioration" is clicked; a drawn group can have its own, and "Critical group" has its chosen patients (4 in every seed checked).
- Window: start to fully in (start plus ramp), plus 120 min (`WINDOW_AFTER_FULL_MIN`, shared with `src/compare.ts`). First alert is the first new alert of that patient in the window, by the alert rule below. If none came, the row says "none in the window", or "window still open" while it can still come. An alert that was already active before the start is not new, as in compare, so Minutes between is never negative. Minutes between is rounded to a whole minute. The first bin closes at minute 15, so for a start at minute 0 an alert already present at the opening shows as 15 minutes.
- The summary entry holds only `start`, `kind`, `alertMin`, `minutesBetween` and `windowOpen`. It holds no ramp length, no end of window and no patient id, so nothing in it is ahead of the clock. `windowOpen` turns false at the first alert, when the patient leaves, or when the window ends; only the last shows the ramp length, and only after the fact. A test checks the keys and that no minute is ahead of the clock after every bin.
- Known limit: an episode whose patient leaves before the next 15-minute bin closes is not listed. In seeds 1 to 40 over 7 days this did not happen (38 evaluated episodes, none missed).
- It is the simulator's own knowledge. No outcome is shown, and the page prints no summary figure for the column.
- Caps: 200 episodes kept (oldest dropped), the newest 50 shown with "Showing the newest 50 of N". A patient's episode stays after the patient leaves.
- With no source that can save, `episodes` is `null` and the page says "Not available here." The viewer build shows no table.

## Skipped spans

If the clock jumps and the page is not fed (the Entrance panel's Skip 1 day), the bins in that span are not recorded. The charts draw a hatched gap labelled "skipped".

## Where the page runs

- Hospital world: all sections.
- Ward-only standalone build: the Hospital section is one line, "This page simulates ward W4 only."
- Viewer build, signed in: the page does not run its own simulation and never shows its own world's numbers. The Hospital section is one line, "Not served: the server runs the whole hospital, but sends this page no totals per unit and hour." The Ward charts each say "Not served: the server sends this page no hourly totals". The Person charts use the patient views the page already has from its `/live` reads. The page adds no request; the open view's poll continues as before.
- Viewer build, watching with no token: only "Sign in to see ward analytics" and the "Sign in to control" button. No request is made.

## Page and run

The Analytics view is drawn inside the ward component. The ward is hidden, not removed, so a standalone run keeps stepping and keeps its history while you look at the page. Going back shows the same run. The page code loads only when the view is first opened, as a separate chunk. Its text is React text: nothing from data goes in a link, a style or a class name. If the page fails to load or a chart throws, only the Analytics view shows "Could not show analytics" and the ward keeps running; switching to Simulation and back tries again. Numbers that are not finite are dropped from the drawing, and a summary with missing arrays shows "No data yet".

## Not in version 1

Staff time away from base, late recognition and vitals against the person's own start are not shown. `staff` in the summary is `null`.
