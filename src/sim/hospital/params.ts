// Every default of the hospital layer, with where it came from. Nothing here is fitted to a Philippine hospital's
// own records: "cited" means a published number (or arithmetic on published numbers only), "judgement" means ours.
// Source notes: research-ph-hospital.md ("PH §x"), the design hospital-design.md §1 and §2.
//   cited       a number read on the page, or derived only from numbers read on the page
//   unverified  a search excerpt only; re-check before quoting
//   judgement   ours; the note says what a better source would be
//   w4_code     a value already in the ward's code, reused unchanged

export type Source = "cited" | "unverified" | "judgement" | "w4_code";
export interface Sourced<T> { value: T; source: Source; note: string }

const cited = <T>(value: T, note: string): Sourced<T> => ({ value, source: "cited", note });
const unverified = <T>(value: T, note: string): Sourced<T> => ({ value, source: "unverified", note });
const judgement = <T>(value: T, note: string): Sourced<T> => ({ value, source: "judgement", note });
const w4Code = <T>(value: T, note: string): Sourced<T> => ({ value, source: "w4_code", note });

const LINK = {
  pids: "https://pidswebs.pids.gov.ph/CDN/PUBLICATIONS/pidsdps1336.pdf",
  pgh2019: "https://fem.tums.ac.ir/index.php/fem/article/view/1243",
  philstar2022: "https://www.philstar.com/headlines/2022/06/07/2186727/pgh-halts-elective-procedures-adds-beds-emergency-room-exceeds-capacity",
  philstar2025: "https://www.philstar.com/headlines/2025/03/28/2431761/critical-overcapacity-pgh-overwhelmed-patient-load-doubles-er",
  abscbn2023: "https://news.abs-cbn.com/video/news/10/06/23/like-a-giant-icu-pgh-sounds-alarm-on-er-congestion",
  acsPilot: "https://actamedicaphilippina.upm.edu.ph/index.php/acta/article/download/1150/1024",
  privateEd: "https://actamedicaphilippina.upm.edu.ph/index.php/acta/article/download/283/4030/84232",
  hfIcu: "https://www.citedrive.com/en/discovery/clinical-profile-and-outcomes-of-heart-failure-patients-in-the-emergency-department-with-disposition-for-intensive-care-unit-admission-in-a-tertiary-hospital-in-the-philippines/",
  dbm: "https://www.dbm.gov.ph/wp-content/uploads/Issuances/2013/Joint%20Circular%202013/DOH/Manual%20RSSGH_%203%20levels.pdf",
  journalNews: "https://journalnews.com.ph/robes-laments-one-nurse-per-hospital-ward-ratio/",
  philhealth: "https://www.philhealth.gov.ph/about_us/statsncharts/snc2023_1stSem.pdf",
  heartAsia: "https://greenprints.dlshsi.edu.ph/faculty_scholarly_works/95",
  stroke: "https://www.frontiersin.org/journals/stroke/articles/10.3389/fstro.2026.1835562/full",
  pghMedicine: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9850543",
  arrest: "https://actamedicaphilippina.upm.edu.ph/index.php/acta/article/view/2935",
  pghIcu: "https://actamedicaphilippina.upm.edu.ph/index.php/acta/article/view/3592",
  news2: "https://www.rcp.ac.uk/media/mrllczrj/news2-chart-4_clinical-response-to-news-trigger-thresholds_0.pdf",
  obsTime: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8249906",
  barwise: "https://psnet.ahrq.gov/issue/delayed-rapid-response-team-activation-associated-increased-hospital-mortality-morbidity-and",
  pghReadmit: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10258940/",
  rrtRates: "https://doi.org/10.1056/NEJMra0910926", // Jones, DeVita, Bellomo, N Engl J Med 2011; the table was not read
};

export type ScenarioKind = "standard" | "typical" | "surge";
export type UnitId = "ER" | "MORGUE" | "ICU" | "MED3A" | "MED3B" | "W4" | "SURG5A";
export type Group = "cardiac" | "stroke" | "hypertensive" | "respiratory" | "infection" | "trauma" | "minor";
export type Triage = "emergent" | "urgent" | "non_urgent";

const perScenario = (standard: Sourced<number>, typical: Sourced<number>, surge: Sourced<number>) => ({ standard, typical, surge });

export interface UnitRow {
  id: UnitId;
  name: string;
  floor: number; // 0 is the ground floor (GF)
  beds: Sourced<number>;
  stretchers: Sourced<number>;
  nurses: Record<ScenarioKind, Sourced<number>>;
  residents: Sourced<number>;
}

const NO_TAG = "The design (§1) gives this value with no tag; marked judgement here. ";
const noNurses = () => perScenario(
  judgement(0, NO_TAG + "No nurses are modelled in the morgue. Better: a DOH morgue staffing standard."),
  judgement(0, NO_TAG + "No nurses are modelled in the morgue. Better: a DOH morgue staffing standard."),
  judgement(0, NO_TAG + "No nurses are modelled in the morgue. Better: a DOH morgue staffing standard."),
);
// The counts below are chosen numbers, so judgement: the ratios read are cited in the notes, the bed counts they are applied to are ours.
const STANDARD = (ratio: string, beds: number) => `Standard ${ratio} per shift [PH §3.1 read] ${LINK.dbm} applied to a judged ${beds} beds, rounded up.`;
const REPORTED = `Reported: PGH general wards 1:20 in a 2022 study, quoted by a legislator [PH §3.1 read] ${LINK.journalNews}; PGH ward 1:16 [PH §3.1 snippet, unverified] https://newsinfo.inquirer.net/?p=1177977 ; 1:20-1:50 claimed with no source named.`;
const BETTER_WARD = "Better: a PH hospital's ward roster by shift.";

export const UNITS: UnitRow[] = [
  {
    id: "ER", name: "Emergency Room", floor: 0,
    beds: judgement(10, `10 bays [derived: PGH ER built for 70-80 with 1,334-1,500 beds, about 5.4%, PH §1.6 read, §2.2 read; times about 175, which is a judgement] ${LINK.philstar2025} ${LINK.philstar2022}. Better: a DOH ER bay standard or a PH ER's bay count.`),
    stretchers: judgement(0, NO_TAG + "ER has no stretcher cap: trolleys and chairs overflow and the census is shown against the 10 bays; 0 means not used. Better: a PH ER's trolley count."),
    nurses: perScenario(
      judgement(3, "[judgement: no DOH ER ratio found] Better: a DOH ER nurse ratio."),
      judgement(2, `[judgement: no DOH ER ratio found; typical gives 1:10-1:18 at census 20-36, near PGH's measured 11.5-15.4 per nurse, PH §2.1b derived] ${LINK.pgh2019} Better: a DOH ER nurse ratio.`),
      judgement(2, "[judgement: no DOH ER ratio found] Surge keeps typical staffing. Better: a DOH ER nurse ratio."),
    ),
    residents: judgement(0, NO_TAG + "ER doctors are in erDoctors by shift, not residents. Better: n/a (structural zero)."),
  },
  {
    id: "MORGUE", name: "Morgue", floor: 0,
    beds: judgement(6, "6 drawers [judgement; better: a DOH hospital morgue standard]."),
    stretchers: judgement(0, NO_TAG + "Overflow is allowed and shown; 0 means no stretcher cells. Better: a DOH hospital morgue standard."),
    nurses: noNurses(),
    residents: judgement(0, NO_TAG + "No doctors in the morgue. Better: a DOH morgue staffing standard."),
  },
  {
    id: "ICU", name: "Intensive Care", floor: 2,
    beds: judgement(10, "[judgement: 5.7% of about 175, inside 4-8% for tertiary, PH §4.3 judgement] Better: a PH tertiary hospital's ICU bed count."),
    stretchers: judgement(0, NO_TAG + "No corridor stretchers in the ICU. Better: n/a."),
    nurses: perScenario(
      judgement(4, `[standard 1:3 PH §3.1 read] ${STANDARD("critical care 1:3", 10)} Better: a PH ICU roster.`),
      judgement(3, "[typical 1:3-1:4 judgement, reality not found] Better: a PH ICU nurse ratio as practised."),
      judgement(3, "[judgement] Surge keeps typical staffing. Better: a PH ICU nurse ratio as practised."),
    ),
    residents: judgement(1, "[judgement] Better: a PH ICU physician cover figure."),
  },
  ...(["MED3A", "MED3B"] as const).map((id): UnitRow => ({
    // One medicine ward per floor, so each has room for bays: MED3B keeps its id (results files use it) but sits on 1F as Medicine 1A.
    id, name: id === "MED3A" ? "Medicine 3A" : "Medicine 1A", floor: id === "MED3A" ? 3 : 1,
    beds: judgement(30, "[judgement] Better: a PH hospital's medicine ward bed count."),
    stretchers: judgement(8, `[judgement; PGH adds 10-15 ward beds when the ER is full, PH §1.5 snippet] ${LINK.philstar2022} (the §2.2 article of that date; the note's own §1.5 source has no URL of its own). Better: a PH hospital's corridor bed count.`),
    nurses: perScenario(
      judgement(3, `${STANDARD("ward 1:12", 30)} ${BETTER_WARD}`),
      judgement(2, `Picked so 30 beds / 2 nurses = 1:15 (1:15-1:19 over the occupancy range) lands near the reported range. ${REPORTED} ${BETTER_WARD}`),
      judgement(2, `Surge keeps typical staffing. ${REPORTED} ${BETTER_WARD}`),
    ),
    residents: judgement(1, "[judgement, PH §3.2] Ward physician cover per shift not found. Better: a PH ward physician cover figure."),
  })),
  {
    id: "W4", name: "Ward W4", floor: 4,
    beds: w4Code(20, "[W4 code] the existing map, 20 beds."),
    stretchers: w4Code(0, "[W4 code] 0: bed labels are the API's contract."),
    nurses: perScenario(
      w4Code(3, "[W4 code] 2 staff nurses + 1 charge nurse, fixed; W4 staffing is not configurable."),
      w4Code(3, "[W4 code] 2 staff nurses + 1 charge nurse, fixed; W4 staffing is not configurable."),
      w4Code(3, "[W4 code] 2 staff nurses + 1 charge nurse, fixed; W4 staffing is not configurable."),
    ),
    residents: w4Code(0, "[W4 code] W4 has 2 attendings, fixed, and no residents."),
  },
  {
    id: "SURG5A", name: "Surgery 5A", floor: 5,
    beds: judgement(24, "[judgement] Better: a PH hospital's surgical ward bed count."),
    stretchers: judgement(6, "[judgement] Better: a PH hospital's corridor bed count."),
    nurses: perScenario(
      judgement(2, `${STANDARD("ward 1:12", 24)} ${BETTER_WARD}`),
      judgement(1, `Picked so 24 beds / 1 nurse = 1:24 falls inside the claimed 1:20-1:50. ${REPORTED} ${BETTER_WARD}`),
      judgement(1, `Surge keeps typical staffing, 1:24. ${REPORTED} ${BETTER_WARD}`),
    ),
    residents: judgement(1, "[judgement] Better: a PH surgical ward physician cover figure."),
  },
];

const shiftCounts = (a: number, b: number, c: number, note: string) => perScenario(judgement(a, note), judgement(b, note), judgement(c, note));
const doctorNote = (shift: string) =>
  `[shifts PH §3.3 read; counts derived from PGH 4 morning / 3 night for 121 a day, PH §2.1 read, ${LINK.pgh2019}] ${shift}; the design counts do not follow from that arithmetic (45-90 a day against 121), so judgement here. Better: a PH ER roster by arrivals.`;

const SPLIT = "Non-cardiac medical (55 minus cardiac 10, a judgement) split by PhilHealth claim counts [PH §5.1 read; claims, not visits], rounded: respiratory = pneumonia + asthma, infection/GI = gastroenteritis + dengue + UTI + peptic ulcer, with COVID pneumonia and newborn sepsis left out (counting COVID pneumonia gives 18.1 / 19.1 / 4.3 / 3.5 percent for respiratory / infection / hypertensive / stroke).";

export const PARAMS = {
  scale: {
    wholeHospitalBeds: judgement(175, "Adult medical and surgical part 114 authorised beds plus OB-gyne and paediatrics at about a third [judgement; PH §4.2 says no unit split exists]. Better: a PH hospital's bed split by unit."),
    levelThreeMeanBeds: cited(225, `Level 3 mean of authorised beds, 2011 [PH §1.1 read] ${LINK.pids}`),
  },
  erDoctors: {
    day: shiftCounts(3, 2, 2, doctorNote("07-19")),
    night: shiftCounts(2, 2, 2, doctorNote("19-07")),
  },
  shifts: {
    nurseStartHours: cited([6, 14, 22], `Nurses 3 x 8 h, 06-14, 14-22, 22-06 [PH §3.3 read, PGH ED] ${LINK.pgh2019}`),
    nurseShiftH: cited(8, `[PH §3.3 read] ${LINK.pgh2019}`),
    erDoctorStartHours: cited([7, 19], `ER doctors 2 x 12 h, 07-19 and 19-07 [PH §3.3 read] ${LINK.pgh2019}`),
    erDoctorShiftH: cited(12, `[PH §3.3 read] ${LINK.pgh2019}`),
    sameNursesOnAllShifts: judgement(true, "The same count on all three shifts [judgement; ward night staffing not found, PH §8]. Better: a PH ward night roster."),
    attendantsPerWardPerShift: cited(1, `Nursing attendants 1 per ward per shift, drawn only [PH §3.1 read, 1 per 24 beds] ${LINK.dbm}`),
  },
  people: {
    maleShare: cited(0.479, `47.9% male, in-hospital arrest cohort used as an adult proxy [PH §7 read] ${LINK.arrest}`),
    ageMean: cited(50.1, `Mean age 50.1 of the same cohort [PH §7 read] ${LINK.arrest}`),
    ageSd: cited(16.7, `SD 16.7 of the same cohort [PH §7 read] ${LINK.arrest}`),
    ageRange: judgement([18, 95], "Normal ages are clipped to 18-95 (adult only) [judgement; the cohort's range was not read]. Better: the cohort's age range or a PH adult admission age distribution."),
    cardiacAgeRange: w4Code([45, 84], "[W4 code] cardiac ages use W4's 45 + floor(rng * 40) so W4's age mix does not change (source.ts, a shortcut there)."),
    namePool: judgement({ surnames: 400, givenPerSex: 150 }, "400 Filipino surnames and 150 given names per sex plus a middle initial (3,120,000 names; before slice A3: 80 and 40, 166,400, still used when returns.enabled is off); synthetic, no real people [judgement]. Better: a published PH name frequency list."),
  },
  warmUpDays: judgement(3, "Analyses may drop the first 3 days as warm-up [judgement; the design gives no tag]. Better: measure how long occupancy takes to settle across seeds."),
  w4: {
    attendings: w4Code(2, "[W4 code] 2 attendings (STAFF in sim.ts), fixed; W4 staffing is not configurable."),
  },
  clock: {
    startMinuteOfDay: w4Code(15 * 60, "[W4 code] minute 0 is 15:00 on day 1, as the ward already runs (START_CLOCK_MIN in source.ts)."),
  },
  startOccupancy: perScenario(
    cited(0.85, `Top of the DOH 80-85% occupancy standard [PH §1.1 read] ${LINK.pids}; the design gives no tag for the start value.`),
    judgement(1, "Start at 100% of authorised beds: Level 3 hospitals averaged 136% in 2011, 62.5% of them above 100% [PH §1.1 read] https://pidswebs.pids.gov.ph/CDN/PUBLICATIONS/pidsdps1336.pdf; the start value itself is ours. Better: a PH hospital's census by ward."),
    judgement(1, "Surge starts as typical does [judgement]. Better: a PH hospital's census by ward."),
  ),
  // Arrivals must be drawn per hour or finer (worst accepted hourly rate 500 x 0.424 / 8 = 26.5), never per 8-hour block
  // (212 is over poisson()'s cap of 50).
  arrivals: {
    perDay: perScenario(
      judgement(40, `Calibrated so medicine occupancy lands near the DOH 80-85% target once ICU step-down inflow (about 1.6 patients a day) and the refit stay are counted; measured about 89% over seeds 101-103 (the seeds hospital.test.ts asserts) and 87.0% over seeds 201-208, 30 days; 45 gave 96.2%. [DOH target 80-85%, PH §1.1 read ${LINK.pids}; the rate is derived through our admit rates and bed counts, which are judgements] Better: a PH ED monthly census.`),
      judgement(60, `[typical: 8.7 medicine admissions a day x about 7.9 effective days = 69 patients, 116% of 60 beds, inside the 95-136% band, PH §1.1 read, §9; derived through our admit rates and bed counts, which are judgements] Better: a PH ED monthly census. Do not scale PGH's 121 a day by beds.`),
      judgement(90, "[surge x1.5 judgement] Better: a PH ED monthly census, PGH's Aug-Nov peak, PH §2.1 read."),
    ),
    // Order: 06-14, 14-22, 22-06. They sum to 1.001 as published (rounded); the rate in a block is perDay x share / 8 h, flat inside it.
    blockShares: cited([0.224, 0.424, 0.353], `ER arrivals by 8-hour block, private ED, Table 4 [PH §2.5 read]; flat inside a block is derived. ${LINK.privateEd}`),
  },
  triage: {
    emergent: cited(0.24, `[PH §2.4 read] PGH 3-level split; emergent derived by subtraction from urgent 47 and non-urgent 29. ${LINK.pgh2019}`),
    urgent: cited(0.47, `[PH §2.4 read] PGH 3-level split. ${LINK.pgh2019}`),
    non_urgent: cited(0.29, `[PH §2.4 read] PGH 3-level split. ${LINK.pgh2019}`),
    independentOfComplaint: judgement(true, "Triage is drawn at arrival, independent of complaint [judgement: no split by complaint found]. Better: a PH ED triage split by diagnosis."),
  },
  complaint: {
    cardiac: judgement(0.10, "[judgement, PH §5.1 says 15-20% of medical] Better: a PH ED census by diagnosis."),
    stroke: judgement(0.04, `${SPLIT} ${LINK.philhealth} Better: a PH ED census by diagnosis.`),
    hypertensive: judgement(0.05, `${SPLIT} ${LINK.philhealth} Better: a PH ED census by diagnosis.`),
    respiratory: judgement(0.16, `${SPLIT} ${LINK.philhealth} Better: a PH ED census by diagnosis.`),
    infection: judgement(0.20, `${SPLIT} ${LINK.philhealth} Better: a PH ED census by diagnosis.`),
    trauma: cited(0.37, `Trauma 37% [PH §2.1 read, PGH adult ED] ${LINK.pgh2019}`),
    minor: cited(0.08, `Minor is the remainder after medical 55 and trauma 37 [PH §2.1 read], derived. ${LINK.pgh2019}`),
  },
  consultMin: judgement(30, `Waiting to consult takes 30 min [judgement; anchor door-to-doctor 45 min, PH §2.3 read n=13, ${LINK.acsPilot}]. Better: a PH ED time-motion study.`),
  patienceMeanH: judgement(6, "Patience before leaving without being seen, exponential, mean 6 h; applies to urgent and non-urgent [judgement; not found]. Better: a PH ED left-without-being-seen rate."),
  // lognormal() takes a MEDIAN: draw with medianH, never meanH (the mean runs 20% longer at sigma 0.6). medianH = meanH x exp(-sigma^2 / 2).
  decisionDelay: {
    sigma: judgement(0.6, "Lognormal sigma of the consult-to-decision delay [judgement]. Better: a PH ED stay distribution."),
    meanH: {
      emergent: judgement(5.2, `Private ED stay mean 6.22 h minus 1 h, PH §2.3 read (best case) ${LINK.privateEd}; the minus 1 h is a judgement. Better: a PH public ED stay by triage.`),
      urgent: judgement(4.5, `Private ED stay mean 5.48 h minus 1 h, PH §2.3 read (best case) ${LINK.privateEd}; the minus 1 h is a judgement. Better: a PH public ED stay by triage.`),
      non_urgent: judgement(2.3, `Private ED stay mean 3.30 h minus 1 h, PH §2.3 read (best case) ${LINK.privateEd}; the minus 1 h is a judgement. Better: a PH public ED stay by triage.`),
    },
    medianH: {
      emergent: judgement(4.343, "5.2 h x exp(-0.6^2 / 2), the median to pass to lognormal() [judgement, from the mean above]. Better: a PH public ED stay by triage."),
      urgent: judgement(3.759, "4.5 h x exp(-0.6^2 / 2), the median to pass to lognormal() [judgement, from the mean above]. Better: a PH public ED stay by triage."),
      non_urgent: judgement(1.921, "2.3 h x exp(-0.6^2 / 2), the median to pass to lognormal() [judgement, from the mean above]. Better: a PH public ED stay by triage."),
    },
  },
  admitRate: {
    cardiac: cited(0.63, `[PH §2.3 read n=30] medical ICU 40% + ward 23.3% of the PGH ACS pilot. ${LINK.acsPilot}`),
    stroke: judgement(0.9, "[judgement] Better: a PH ED admission rate by diagnosis."),
    hypertensive: judgement(0.4, "[judgement] Better: a PH ED admission rate by diagnosis."),
    respiratory: judgement(0.3, "[judgement] Better: a PH ED admission rate by diagnosis."),
    infection: judgement(0.2, "[judgement] Better: a PH ED admission rate by diagnosis."),
    trauma: judgement(0.2, "[judgement] Better: a PH ED admission rate by diagnosis."),
    minor: judgement(0.02, "[judgement] Better: a PH ED admission rate by diagnosis."),
  },
  icuIndicated: { // share of those admitted
    cardiac: cited(0.63, `0.63 of admitted, 40% of 63% [PH §2.3 read n=30]. ${LINK.acsPilot}`),
    stroke: cited(0.235, `ICU or monitored bed 23.5% [PH §6 read] ${LINK.stroke}`),
    trauma: judgement(0.05, "[judgement] Better: a PH ICU admission share by diagnosis."),
    hypertensive: judgement(0.03, "[judgement] Better: a PH ICU admission share by diagnosis."),
    respiratory: judgement(0.03, "[judgement] Better: a PH ICU admission share by diagnosis."),
    infection: judgement(0.03, "[judgement] Better: a PH ICU admission share by diagnosis."),
    minor: judgement(0.03, "[judgement] Better: a PH ICU admission share by diagnosis."),
  },
  placement: judgement(
    { cardiac: ["W4"], trauma: ["SURG5A"], others: ["MED3A", "MED3B"] },
    "Admit to the group's unit bed (cardiac W4, trauma SURG5A, others MED3A then MED3B); ICU-indicated take a free ICU bed first [judgement]. Better: a PH hospital's admission routing policy.",
  ),
  peopleCap: judgement(600, "Most people the house holds at once (beds, stretchers, the ER queue, boarders and bodies); about three times a full house, so it is reached only when something is wrong. An arrival beyond it is turned away at the door and recorded. Better: a PH hospital's peak census."),
  bufferCap: {
    events: judgement(5000, "Most event rows kept when no caller drains them; the oldest go first. A caller drains each hour. Better: n/a (a memory limit)."),
    hourly: judgement(1500, "Most hourly rows kept when no caller drains them (7 a hour, so about 9 days); the oldest go first. Better: n/a (a memory limit)."),
  },
  transferOutAfterH: judgement(72, "Boarding over 72 h ends in a transfer out [judgement; PH §2.2 snippet \"3 days to 3 weeks\", DOH asked 20 hospitals to take overflow] " + `${LINK.abscbn2023} https://www.sunstar.com.ph/manila/pgh-emergency-room-overwhelmed-by-patients Better: a PH median boarding time.`),
  stay: {
    // Two read facts (PH §6, PGH general medicine, 2019): the NORMAL-stay group has median 6 days, and 19.2% of admissions stay 14 days or more.
    // Lognormal(median 7.22, sigma 0.761) meets both: P(>= 14 d) = 0.192 and the median of stays under 14 d = 6.01 (checked in scenario.test.ts).
    // The design's first fit (median 6, sigma 0.965) gives that normal group a median of 4.77 d, so it misread the source. The design's occupancy
    // arithmetic (about 116% typical) was done with the old value; slice H2's calibration test is where the arrival rates are confirmed.
    medicine: {
      medianDays: cited(7.22, `Lognormal median fitted to two read facts [PH §6 read, derived]: normal-group median 6 d and 19.2% staying 14 d or more; the fit gives 6.01 d and P(>= 14 d) = 0.192. Two assumptions are ours, not the paper's: the lognormal shape, and reading the normal group as stays under 14 d. ${LINK.pghMedicine}`),
      sigma: cited(0.761, `Lognormal sigma fitted with median 7.22 to the same two read facts [PH §6 read, derived]. ${LINK.pghMedicine}`),
      normalGroupMedianDays: cited(6, `Median stay of the normal group, 6 days [PH §6 read] ${LINK.pghMedicine}`),
      shareAtLeast14Days: cited(0.192, `19.2% of admissions stayed 14 days or more (prolonged-stay group, median 19 d) [PH §6 read] ${LINK.pghMedicine}`),
    },
    stroke: {
      medianDays: cited(5, `Stroke median stay 5.0 days, IQR 2.0-10.5 [PH §6 read] ${LINK.stroke}`),
      sigma: cited(1.23, `Lognormal sigma derived from the IQR 2.0-10.5 [PH §6 read]: ln(10.5/2)/1.349. ${LINK.stroke}`),
    },
    surgery: {
      medianDays: judgement(4, "[judgement] Better: PhilHealth surgical package stays."),
      sigma: judgement(0.8, "[judgement] Better: PhilHealth surgical package stays."),
    },
    kindOfGroup: judgement(
      { stroke: "stroke", trauma: "surgery", others: "medicine" },
      "Which stay distribution a group draws from [judgement]. Better: PhilHealth stays by diagnosis.",
    ),
    capDays: w4Code(30, "[W4 code] MAX_STAY_DAYS in source.ts."),
    dischargeClock: w4Code(
      { earlyShare: 0.15, earlyHours: [8, 12], lateHours: [12, 19] },
      "[W4 code] dueAt in source.ts: about 15% leave 08-12, the rest 12-19, as W4's discharge clock hour.",
    ),
  },
  icuStay: {
    meanDays: cited(5, `PGH ICU mean stay 5 days, n=64 [PH §6 read] ${LINK.pghIcu}`),
    medianDays: judgement(4, "Median 4 d with sigma 0.67 gives the mean 5 d [shape judgement]. Better: a PH ICU stay distribution."),
    sigma: judgement(0.67, "Shape of the ICU stay [judgement]. Better: a PH ICU stay distribution."),
  },
  death: {
    erOverall: cited(0.028, `ER deaths 1,217 of 43,632 consults, 2.8% [PH §2.1 derived from read] ${LINK.pgh2019}`),
    erPhase: {
      emergent: judgement(0.10, "ER-phase death by triage, 2.8% overall [split judgement]. Better: a PH ED mortality by triage level."),
      urgent: judgement(0.008, "ER-phase death by triage, 2.8% overall [split judgement]. Better: a PH ED mortality by triage level."),
      non_urgent: judgement(0, "ER-phase death by triage, 2.8% overall [split judgement]. Better: a PH ED mortality by triage level."),
    },
    erPhaseWindowH: judgement(12, "An ER-phase death falls at a uniform 0-12 h after arrival [judgement]. Better: a PH ED time-to-death distribution."),
    admitted: { // P(die in the stay | admitted and alive), at a uniform time in the stay
      stroke: cited(0.205, `In-hospital mortality in public hospitals 20.5% [PH §6 read] ${LINK.stroke}`),
      cardiac: unverified(0.082, `HF national PhilHealth 2014 mortality 8.2%, from the team's earlier note, not reopened [PH §6 snippet]. No URL for the figure itself in the research note; the nearest source it lists is the Heart Asia 2017 HF paper: ${LINK.heartAsia}`),
      cardiacIcuIndicated: cited(0.171, `HF with ICU disposition, in-hospital mortality 17.1% [PH §2.3 read] ${LINK.hfIcu}`),
      medicine: cited(0.13, `Hypertensive, respiratory and infection groups: PGH general medicine 50 of 386 died, 12.95% [PH §6 read, derived] ${LINK.pghMedicine}`),
      trauma: judgement(0.03, "[judgement] Better: a PH surgical or trauma in-hospital mortality."),
      minor: judgement(0, "[judgement] Better: a PH ED minor-complaint admission mortality."),
    },
    w4FatalGivenEpisode: judgement(0.4, "P(fatal | W4 deterioration episode) [judgement]; HF 8.2% nationally (PH §5.2) is the upper anchor, since only 6.1% of W4 admissions deteriorate. Better: PH cardiac in-hospital mortality split by ward and ICU."),
    w4DeathAfterFullH: judgement(2, "A W4 death falls 2 h after the episode is fully in (injectAt + rampMin) [judgement]. Better: a PH time from deterioration to death."),
  },
  morgue: {
    toMorgueH: judgement(2, "A body reaches the morgue 2 h after death [judgement]. Better: a DOH or hospital morgue policy."),
    releasedAfterH: judgement(24, "A body is released 24 h after reaching the morgue; its bed stays blocked until then [judgement]. Better: a DOH or hospital morgue policy."),
  },
  anchors: { // outputs to compare with, never fitted
    erAdmitShare: cited(0.28, `PGH ER admissions 28% of consults [PH §2.1 read] ${LINK.pgh2019}`),
    icuAccessForIcuBoundHF: cited(0.189, `18.9% of ICU-bound HF reached an ICU bed [PH §2.3 read] ${LINK.hfIcu}`),
  },
  // Observation rounds outside W4 and the ICU (slice A1, workload-design.md). Class "watch": ICU-indicated not in the ICU, or
  // emergent in the ER; "routine": everyone else. No DOH or Philippine observation-frequency standard was found.
  obs: {
    intervalMin: {
      watch: cited(60, `NEWS2 5 or more, or 3 in one parameter: "minimum 1 hourly" [NEWS2 Chart 4, RCP, read] ${LINK.news2}. No PH standard found.`),
      routine: cited(240, `NEWS2 1-4: "minimum 4-6 hourly" [NEWS2 Chart 4, RCP, read] ${LINK.news2}; 4 h, the band's start, taken. No PH standard found.`),
    },
    graceMin: { // a round is late when done more than this after it fell due
      watch: judgement(30, `[judgement] NEWS2 Chart 4 asks review within 60 min at 5-6 ${LINK.news2}; 30 min is ours. Better: a PH ward observation policy.`),
      routine: cited(120, `[derived from NEWS2 Chart 4, read] due at 4 h, the "4-6 hourly" band ends at 6 h, so 2 h ${LINK.news2}.`),
    },
    roundMin: cited(5, `One set of observations takes 5 min 01 s per round (authors' preferred figure; 3 min 45 s bedside only, 6 min 26 s with all interruptions), 16 English wards, 680 sets [Dall'Ora 2021, read] ${LINK.obsTime}; England, not PH. Better: a PH time-motion study.`),
    shareOfNurseTime: judgement(0.25, "Each nurse gives a quarter of each minute (15 min per nurse-hour) to observation rounds; the rest is medicines, admissions, charting [judgement; no nurse share of time on observations found]. Better: a PH nurse activity study."),
    lateThresholdMin: judgement(60, `[judgement: Barwise's figure was read in a search abstract only, not on the page] Recognition is late when the round that notices a deterioration comes over 60 min after onset: Barwise 2016's delay definition (over 1 h from first abnormal sign to the call; abstract via search, not read on the page) ${LINK.barwise}, and NEWS2 Chart 4's 60-min review ${LINK.news2}. Better: Barwise 2016 read in full, or a PH escalation standard.`),
    excessDeathPerHour: judgement(0.02, `P(death caused by the delay) = 1 - exp(-0.02 x delay in hours) [judgement, the one tunable number]: at 3.5 h it gives about 7%, near Barwise 2016's 15% vs 8% hospital mortality for delayed vs not (adjusted OR 1.6; an association, not a cause; search excerpt only) ${LINK.barwise}. Better: a PH study of time to escalation and death.`),
  },
  // Late recognition outside W4 and the ICU (slice A2, workload-design.md). A course is drawn from its own stream per person;
  // nobody on a ward or boarding in the ER knows of it until the next observation round reaches them.
  course: {
    ratePerDay: { // P(deteriorates) = 1 - exp(-rate x ward stay days), at a uniform point of the drawn ward stay
      medicine: judgement(0.010, `Hypertensive, respiratory, infection [judgement]: 20-40 rapid-response calls per 1,000 admissions (NEJM review table, snippet, not verified) ${LINK.rrtRates} is about 0.003-0.005 a day at a 7-8 d stay in high-income wards; PH wards are sicker (13% medicine mortality, death.admitted.medicine). Better: a PH ward deterioration or RRT rate.`),
      stroke: judgement(0.010, "As medicine [judgement]. Better: a PH stroke ward deterioration rate."),
      cardiac: judgement(0.015, "Only cardiac people boarding off W4 reach this [judgement]. Better: a PH cardiac ward deterioration rate."),
      trauma: judgement(0.005, "[judgement] Better: a PH surgical ward deterioration rate."),
      minor: judgement(0.002, "[judgement] Better: n/a (rarely admitted)."),
    },
    deathAfterNoticedH: judgement(6, "A death caused by late recognition falls 6 h after the notice [judgement]. Better: a PH time from late escalation to death."),
    stayDeathScale: judgement(0.98, "Orchestrator ruling 2026-11-12: deaths are calibrated, not added. The pre-drawn stay-death probability of everyone admitted during the run is multiplied by this; chosen from one measurement (2 excess deaths, seeds 101-103) so typical deaths stay within 5% of version 2's on those seeds; not shown in expectation. Not a source: typical, W4 always full, scale 1 gave 2 deaths after late recognition against 114 pre-drawn deaths of people admitted in the run, 1 - 2 / 116 = 0.983, rounded to 0.98. Re-derive when a course number changes. Better: a PH ward death rate split by recognised and missed deterioration."),
    escalate: judgement(true, "A noticed deterioration joins the hourly watch class and asks for an ICU bed (ward to ICU, or ICU first from ER boarding) [judgement; design A2]. Off only in tests, to show the course adds nothing else. Better: a PH hospital's escalation policy for a deteriorating ward patient."),
  },
  // Returning patients and more varied people (slice A3). A return takes the place of an arrival that would have happened, so
  // arrivalsPerDay and every earlier calibration stay where they are. The switch also selects the larger name pool.
  returns: {
    enabled: judgement(true, "Off only in tests, to show the people, returns and look add nothing else; off also keeps the old 80 x 80 name lists. Better: n/a."),
    readmit30: {
      medicine: unverified(0.18, `Hypertensive, respiratory, infection: about 18% (602 of 4,010) of PGH General Medicine discharges in 2019 were readmitted within 30 days, mostly unplanned and related to the index stay [search excerpt only, page not read] ${LINK.pghReadmit}; one hospital. Better: a PH readmission rate by condition.`),
      other: judgement(0.18, "Cardiac, stroke, trauma, minor: the medicine figure applied to all groups (orchestrator ruling 2026-11-12) [judgement]. Real readmission varies by condition. Better: a PH readmission rate by condition."),
    },
    cap: judgement(300, "Most returns waiting at once; one past it is dropped and recorded (return_dropped) [judgement; a memory bound, like the last 300 who left]. Better: n/a (a memory limit)."),
  },
};
