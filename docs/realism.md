# Realism: what "fitted to real data" means here

The pitch says the simulator is "trained on real hospital data, so heart rate, breathing, oxygen, temperature, blood pressure and heart rhythm all move the way they would in a real patient". This page says exactly how far that is true. `npm run realism` prints the numbers.

Everything the simulator produces is synthetic. No patient's values are in this repository.

## Run it

```bash
npm run realism
```

It takes about three minutes: it runs the ward for 30 simulated days, six times. It takes no arguments. It prints one table and exits 0 when every check has the status the test suite expects. The same Node major version prints the same bytes.

The command adds no new check. It recomputes the checks the test suite already makes (`src/sim/sim.test.ts`, `src/sim/calibration.test.ts`, `src/sim/published.test.ts`) with the same seeds, lengths and tolerances, and prints both sides. `src/realism.test.ts` fails if the command and those tests drift apart.

## The short answer, signal by signal

| Signal | Fitted from | Compared with real data it was not fitted to? | Result |
|---|---|---|---|
| Heart rate | eICU (ICU stays), BIDMC (minute noise) | Yes: held-out eICU hospitals, and published ward percentiles (Welch 2015) | All pass |
| Breathing | eICU, BIDMC | Yes: the same two | Passes, with one known miss: 5-minute changes are too small |
| Oxygen (SpO2) | eICU, BIDMC | Yes: the same two | Known misses: 5-minute changes are too small, and the low end is too high (1st percentile 90.3 against 86) |
| Blood pressure | eICU | Systolic only: held-out eICU hospitals and Welch 2015 | Systolic passes. Diastolic is fitted and never tested |
| Temperature | eICU for the spread; literature for "does not rise in an episode" | No | Not compared with real data |
| Heart rhythm | MIT-BIH Arrhythmia, AFDB, LTAFDB (Holter recordings) | No | Not compared with real data. The ECG strip on screen is drawn from the heart rate; it is not data |

So "all move the way they would in a real patient" is supported by held-out comparisons for heart rate, breathing, oxygen and systolic blood pressure, with the misses listed below. For temperature and heart rhythm the simulator's constants come from real recordings, but nothing tests the result against real data.

## What the data is, and is not

- **Intensive care stays**, not ward stays: eICU-CRD Demo 2.0.1, restricted to six-hour windows with ward-like medians. No open ward-level dataset was found.
- **Bedside monitor recordings** (BIDMC PPG and Respiration), used for minute-to-minute noise.
- **Holter and atrial fibrillation recordings** (MIT-BIH Arrhythmia, AFDB, LTAFDB), used for beat timing.
- **Not a general ward. Not the Philippines.** The eICU hospitals are in the United States.
- "Fitted" means summary statistics (spreads, correlations, step sizes) were estimated from those recordings and now drive a random generator. No model was trained to predict anything, and no recording is replayed.
- The table of which generator part comes from which dataset, with licences, is in the README under "Fitted to real data". Attribution is in `NOTICE.md`.

## How to read the table

| Verdict | Meaning |
|---|---|
| `pass` | The simulator's number is inside the tolerance of a real number it was not set from |
| `known miss` | It is outside the tolerance. The test suite marks it as an expected failure, with the reason below |
| `fitted target` | The simulator was set from this very number, so agreement is by construction. This is not evidence of realism |
| `no real comparison` | Fitted from real recordings, but no test compares the result with real data |

| Real data | What it is |
|---|---|
| eICU held-out hospitals | 46 of the 186 eICU hospitals, kept out of the fit in `src/sim/fitted.json` |
| eICU calibration hold-out | Stays kept out of `src/sim/calibration.json` only. That file uses another hospital split, so these stays are NOT guaranteed to be outside the generator's own fit. Read these rows as a weaker check |
| Welch 2015 | Published percentiles from monitored wards in ten US hospitals. Never used for fitting |
| RCP 2012 | Published shares of observation sets by NEWS band, medical wards. Never used for fitting. NEWS 2012, not NEWS2 |
| van Goor 2022 (set from) | The 24-hour swing the simulator's amplitude was set to |

The tolerances are the test suite's own. They are judgement values, not statistical tests.

## Real output

```
check | signal                     | statistic                                     | sim    | real      | tolerance       | verdict            | real data
A1    | heart rate                 | sd, 5-min reads                               | 6.12   | 6.07      | ratio 0.75-1.25 | pass               | eICU held-out hospitals
A1    | heart rate                 | lag-1 (5 min) autocorrelation                 | 0.709  | 0.813     | abs diff < 0.2  | pass               | eICU held-out hospitals
C1    | heart rate                 | change sd, lag 5 min                          | 3.12   | 2.30-4.30 | inside p25-p75  | pass               | eICU calibration hold-out
C2    | heart rate                 | change sd, lag 15 min                         | 5.02   | 3.37-5.93 | inside p25-p75  | pass               | eICU calibration hold-out
C3    | heart rate                 | change sd, lag 60 min                         | 7.48   | 4.67-8.19 | inside p25-p75  | pass               | eICU calibration hold-out
C4    | heart rate                 | change sd, lag 180 min                        | 7.38   | 5.06-8.60 | inside p25-p75  | pass               | eICU calibration hold-out
D1    | heart rate                 | p1, 5-min held values                         | 51.45  | 50        | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
D1    | heart rate                 | p5, 5-min held values                         | 59.80  | 58        | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
D1    | heart rate                 | p10, 5-min held values                        | 65.00  | 63        | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
D1    | heart rate                 | p50, 5-min held values                        | 84.66  | 81        | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
D1    | heart rate                 | p90, 5-min held values                        | 104.02 | 105       | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
D1    | heart rate                 | p95, 5-min held values                        | 108.95 | 112       | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
D1    | heart rate                 | p99, 5-min held values                        | 118.33 | 128       | abs diff <= 10  | pass               | Welch 2015 (monitored wards)
A2    | breathing                  | sd, 5-min reads                               | 2.69   | 3.00      | ratio 0.75-1.25 | pass               | eICU held-out hospitals
A2    | breathing                  | lag-1 (5 min) autocorrelation                 | 0.531  | 0.567     | abs diff < 0.2  | pass               | eICU held-out hospitals
C5    | breathing                  | change sd, lag 5 min                          | 1.71   | 1.96-3.08 | inside p25-p75  | known miss         | eICU calibration hold-out
C6    | breathing                  | change sd, lag 15 min                         | 2.56   | 2.39-3.67 | inside p25-p75  | pass               | eICU calibration hold-out
C7    | breathing                  | change sd, lag 60 min                         | 3.47   | 2.80-4.58 | inside p25-p75  | pass               | eICU calibration hold-out
C8    | breathing                  | change sd, lag 180 min                        | 3.33   | 2.84-4.70 | inside p25-p75  | pass               | eICU calibration hold-out
D2    | breathing                  | p1, 5-min held values                         | 9.51   | 7         | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D2    | breathing                  | p5, 5-min held values                         | 11.82  | 10        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D2    | breathing                  | p10, 5-min held values                        | 13.06  | 11        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D2    | breathing                  | p50, 5-min held values                        | 18.19  | 16        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D2    | breathing                  | p90, 5-min held values                        | 23.66  | 23        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D2    | breathing                  | p95, 5-min held values                        | 25.21  | 25        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D2    | breathing                  | p99, 5-min held values                        | 28.59  | 30        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
A3    | SpO2                       | sd, 5-min reads                               | 1.52   | 1.78      | ratio 0.75-1.25 | pass               | eICU held-out hospitals
A3    | SpO2                       | lag-1 (5 min) autocorrelation                 | 0.614  | 0.641     | abs diff < 0.2  | pass               | eICU held-out hospitals
C9    | SpO2                       | change sd, lag 5 min                          | 0.92   | 0.94-1.63 | inside p25-p75  | known miss         | eICU calibration hold-out
C10   | SpO2                       | change sd, lag 15 min                         | 1.50   | 1.20-2.08 | inside p25-p75  | pass               | eICU calibration hold-out
C11   | SpO2                       | change sd, lag 60 min                         | 1.92   | 1.61-2.57 | inside p25-p75  | pass               | eICU calibration hold-out
C12   | SpO2                       | change sd, lag 180 min                        | 1.89   | 1.68-2.72 | inside p25-p75  | pass               | eICU calibration hold-out
D3    | SpO2                       | p1, 5-min held values                         | 90.30  | 86        | abs diff <= 3   | known miss         | Welch 2015 (monitored wards)
D3    | SpO2                       | p5, 5-min held values                         | 92.63  | 89        | abs diff <= 3   | known miss         | Welch 2015 (monitored wards)
D3    | SpO2                       | p10, 5-min held values                        | 93.66  | 91        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D3    | SpO2                       | p50, 5-min held values                        | 97.12  | 95        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D3    | SpO2                       | p90, 5-min held values                        | 100.00 | 99        | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D3    | SpO2                       | p95, 5-min held values                        | 100.00 | 100       | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
D3    | SpO2                       | p99, 5-min held values                        | 100.00 | 100       | abs diff <= 3   | pass               | Welch 2015 (monitored wards)
H1    | temperature                | fitted from eICU; not tested                  | -      | -         | -               | no real comparison | none
B1    | blood pressure (systolic)  | cuff step sd, 30 min                          | 16.65  | 15.28     | ratio 0.75-1.25 | pass               | eICU held-out hospitals
B2    | blood pressure (systolic)  | cuff step sd, 180 min                         | 20.48  | 19.94     | ratio 0.75-1.25 | pass               | eICU held-out hospitals
D4    | blood pressure (systolic)  | p1, 5-min held values                         | 74.00  | 83        | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
D4    | blood pressure (systolic)  | p5, 5-min held values                         | 92.00  | 93        | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
D4    | blood pressure (systolic)  | p10, 5-min held values                        | 98.00  | 98        | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
D4    | blood pressure (systolic)  | p50, 5-min held values                        | 120.00 | 121       | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
D4    | blood pressure (systolic)  | p90, 5-min held values                        | 150.00 | 151       | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
D4    | blood pressure (systolic)  | p95, 5-min held values                        | 160.00 | 161       | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
D4    | blood pressure (systolic)  | p99, 5-min held values                        | 178.00 | 180       | abs diff <= 15  | pass               | Welch 2015 (monitored wards)
B3    | blood pressure (diastolic) | fitted from eICU; not tested                  | -      | -         | -               | no real comparison | none
R1    | heart rhythm               | fitted from MIT-BIH, AFDB, LTAFDB; not tested | -      | -         | -               | no real comparison | none
E1    | NEWS2                      | % of sets at 5+                               | 34.66  | 20        | abs diff <= 7   | known miss         | RCP 2012 (medical wards)
E2    | NEWS2                      | % of sets at 7+                               | 16.25  | 10        | abs diff <= 5   | known miss         | RCP 2012 (medical wards)
F1    | heart rate                 | 24-h swing                                    | 6.77   | 6.90      | abs diff <= 1.5 | fitted target      | van Goor 2022 (set from)
F2    | breathing                  | 24-h swing                                    | 0.97   | 1.00      | abs diff <= 0.5 | fitted target      | van Goor 2022 (set from)

synthetic, not validated
held out: eICU-CRD Demo 2.0.1 hospitals not used to fit src/sim/fitted.json (46 of 186)
calibration rows: stays held out from src/sim/calibration.json only, not from the fit in src/sim/fitted.json (another hospital split)
published: Welch 2015 (US monitored wards) and RCP 2012, never used for fitting
fitted target: the simulator was set from this number, so agreement is by construction
fitted from: adult ICU (eICU-CRD Demo, BIDMC) and Holter and AF (MIT-BIH, AFDB, LTAFDB) recordings; not a general ward, not the Philippines
only ward W4 has vitals; summary statistics only; fitted and calibration data ODbL v1.0, see NOTICE.md
```

## The five known misses

| Check | Simulator | Real | Why |
|---|---|---|---|
| Breathing, change over 5 minutes (C5) | 1.71 | 1.96 to 3.08 | The minute noise comes from BIDMC and runs below eICU's 5-minute medians |
| SpO2, change over 5 minutes (C9) | 0.92 | 0.94 to 1.63 | The same reason |
| SpO2, low end (D3) | 1st and 5th percentiles 90.30 and 92.63 | 86 and 89 | Simulated patients desaturate less deeply than monitored ward patients. No cause is established |
| Observation sets at NEWS 5 or more (E1) | 34.66% | about 20% | The test samples sick patients at the NEWS2 minimum frequency (hourly at 5 or more); real wards often fall short of that. RCP's figure is for NEWS 2012 |
| Observation sets at NEWS 7 or more (E2) | 16.25% | about 10% | The same reason |

The project's goals table says "three known misses". Those are the three published-figure checks (D3, E1, E2). The two calibration checks (C5, C9) are also expected failures in the test suite, so the report shows five.

A known miss that starts passing makes the command exit 1, as the test suite's expected-failure marker does. The marker must then come off.

## What is not matched or not modelled

- **Temperature** is not compared with real data. It does not rise in a deterioration episode, by design: ward studies find it does not separate patients who go on to cardiac arrest from controls (see the README).
- **Heart rhythm** is not compared with real data. There is no ECG waveform; the strip on the chart is drawn from the heart rate.
- **Diastolic pressure** follows systolic by a fitted relation and is not tested.
- **Blood pressure is a cuff reading** taken by a nurse. The patch does not measure it.
- **Only ward W4 has vitals.** The other hospital units have people, beds and staff, but no vital signs.
- **No infection or fever episode** is modelled.
- **Deterioration episodes** are vital-sign changes defined by this project's own rule on ICU data. No open dataset labels deterioration.
- **Realism only.** None of this says how well BioSentry predicts. No model result may be reported from this synthetic data.

## Licences

`src/sim/fitted.json` and `src/sim/calibration.json` are derived from eICU-CRD Demo and are under ODbL v1.0; the other sources are ODC-By v1.0. See `NOTICE.md`. The report prints summary statistics only.
