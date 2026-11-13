/// <reference types="node" />
// Two arms, one seed, one difference: `npm run compare -- --seed N --days N --baseline B --change C --out DIR`.
// Pure functions take strings and objects and return the text of compare.json and compare.txt; the CLI at the bottom only
// reads files and writes the result. It must not import src/trial.ts or src/hospital-trial.ts: their CLI would run inside the bundle.
// Every input check runs before any arm; the pairing checks run after the arms and also refuse. A refusal is one line on stderr and exit 2, and nothing is written.
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arbitrate } from "./sim/arbiter";
import { createHospital } from "./sim/hospital/step";
import { MAX_BYTES, parseScenario, ScenarioError, type Scenario } from "./sim/hospital/scenario";
import { LIMITS, runHospitalTrial } from "./sim/hospital/trial";
import { scoreNews2 } from "./sim/news2";
import { runTrial, SCENARIO_V1 } from "./sim/trial";

export class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };
// Echoed text: at most 40 characters, control, format and separator characters shown as "?".
const clean = (text: string) => [...text].slice(0, 40).map((ch) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(ch) ? "?" : ch)).join("");

// Both follow BioSentry-Intelligence research/alerts.py and research/events.py. They are a judgement, not a clinical figure.
const REARM_BINS = 16; // quiet bins (4 h) before a patient can alert again
const WINDOW_AFTER_FULL_MIN = 120; // the episode window ends this long after the offset is fully in
const BIN_MIN = 15;

export type CompareFiles = Record<"compare.json" | "compare.txt", string>;
type Json = Record<string, unknown>;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const rows = (csv: string) => csv.trimEnd().split("\n").slice(1).map((l) => l.split(","));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const share = (n: number, of: number) => (of === 0 ? null : r4(n / of));

/** Every leaf by dotted path. An array or a null is a leaf. */
function leaves(v: unknown, prefix = ""): Json {
  if (!isObj(v)) return { [prefix]: v };
  return Object.assign({}, ...Object.entries(v).map(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k)));
}
/** change minus baseline; null where either side is not a number. */
const diff = (a: unknown, b: unknown): unknown =>
  typeof a === "number" && typeof b === "number" ? r4(b - a)
    : isObj(a) && isObj(b) ? Object.fromEntries(Object.keys({ ...a, ...b }).map((k) => [k, diff(a[k], b[k])])) : null;

interface Report { mode: string; seed: number; days: number; baseline: unknown; change: { kind: string; name: string; fields: { path: string; baseline: unknown; change: unknown }[] }; pairing: { status: string; same_person_at_each_arrival: boolean; lines: string[] }; arms: { baseline: unknown; change: unknown }; notes: string[] }

function render(r: Report, difference: unknown, nodeMajor: number): CompareFiles {
  const json = { compare_format: 1, synthetic: true, mode: r.mode, seed: r.seed, days: r.days, node_major: nodeMajor, baseline: r.baseline, change: r.change, pairing: r.pairing, arms: r.arms, difference, notes: r.notes };
  // The Node version is in the JSON only, so the text report reads the same on every Node version.
  const L = [`compare ${r.mode}: seed ${r.seed}, ${r.days} days`, `baseline: ${isObj(r.baseline) ? r.baseline.name : r.baseline}`, `change: ${r.change.kind} ${r.change.name}`];
  for (const f of r.change.fields) L.push(`  ${f.path}: ${f.baseline} -> ${f.change}`);
  L.push(`pairing: ${r.pairing.status}`, ...r.pairing.lines.map((l) => `  ${l}`), "");
  const [b, c, d] = [leaves(r.arms.baseline), leaves(r.arms.change), leaves(difference)];
  const all = Object.keys({ ...b, ...c });
  const kind = (p: string) => (Array.isArray(b[p] ?? c[p]) ? "list" : typeof (b[p] ?? c[p]) === "string" ? "text" : "cell");
  const paths = all.filter((p) => kind(p) === "cell"); // the table holds numbers only
  const w = Math.max(...paths.map((p) => p.length), 6);
  const cell = (v: unknown) => (v === null || v === undefined ? "-" : String(v)).padStart(12);
  L.push(`${"metric".padEnd(w)}${"baseline".padStart(14)}${"change".padStart(14)}${"difference".padStart(14)}`);
  for (const p of paths) L.push(`${p.padEnd(w)}  ${cell(b[p])}  ${cell(c[p])}  ${cell(d[p])}`);
  // Lists and fixed wording (a caveat label next to a figure) go under the table, one line per arm.
  for (const p of all.filter((x) => kind(x) !== "cell")) for (const [arm, v] of [["baseline", b[p]], ["change", c[p]]] as const) L.push(`${p} ${arm}: ${(Array.isArray(v) ? v.join(" ") : v) || "-"}`);
  L.push("", ...r.notes.map((n) => `note: ${n}`), "synthetic, not validated");
  return { "compare.json": `${JSON.stringify(json, null, 2)}\n`, "compare.txt": `${L.map((l) => l.trimEnd()).join("\n")}\n` };
}

// ---- W4 ----

type Hit = (total: number | null, escalated: boolean) => boolean;
const RULE_USE = "use news2_total_ge_K (K 1 to 20) or news2_chart_trigger";
export function parseRule(text: string): Hit {
  if (text === "news2_chart_trigger") return (_t, escalated) => escalated;
  const k = /^news2_total_ge_([1-9]|1\d|20)$/.exec(text)?.[1];
  return k === undefined ? refuse(`rule: unknown "${clean(text)}"; ${RULE_USE}`) : (t) => t !== null && t >= Number(k);
}

interface Row { id: string; minute: number; total: number | null; escalated: boolean }
/** Re-scores every cohort row from its inputs. A row that disagrees with its own ranked and news2 is a broken pairing. */
export function rescore(cohortCsv: string): Row[] {
  const n = (v: string) => (v === "" ? null : Number(v));
  return rows(cohortCsv).map((c) => {
    const r = scoreNews2({ respiratory_rate: n(c[3]), spo2: n(c[4]), spo2_scale: Number(c[11]) as 1 | 2, supplemental_o2: c[10] === "1", systolic_bp: n(c[6]), heart_rate: n(c[2]), consciousness: c[9] as "A", temperature: n(c[5]) });
    const total = r.kind === "score" ? r.total : null;
    if (c[13] !== (total === null ? "0" : "1") || c[14] !== (total === null ? "" : String(total))) refuse("pairing broken: a cohort row does not re-score to its news2");
    return { id: c[0], minute: Number(c[1]), total, escalated: (d => d.kind === "ranked" && d.escalated)(arbitrate(c[0], r)) };
  });
}

export function w4Arm(byPatient: Map<string, Row[]>, hit: Hit, episodes: string[][], patientDays: number, days: number) {
  const alerts = new Map<string, number[]>();
  const hits = new Map<string, number[]>();
  let bins = 0;
  for (const [id, rs] of byPatient) {
    let armed = true, quiet = 0, last: number | null = null;
    const fired: number[] = [], on: number[] = [];
    // A bin that is not alerting counts toward re-arming; a bin in a gap in the rows is one of them.
    const quietBin = () => { if (!armed && ++quiet >= REARM_BINS) armed = true; };
    for (const r of rs) {
      for (let g = last === null ? 0 : (r.minute - last) / BIN_MIN - 1; g > 0; g -= 1) quietBin();
      last = r.minute;
      bins += 1;
      if (hit(r.total, r.escalated)) {
        on.push(r.minute);
        if (armed) fired.push(r.minute);
        armed = false;
        quiet = 0;
      } else quietBin();
    }
    alerts.set(id, fired);
    hits.set(id, on);
  }
  // Starting patients (admit minute 0) are not evaluated; an episode must start inside the stay and before the trial end.
  const evaluated = episodes.filter((e) => Number(e[1]) > 0 && e[5] !== "" && Number(e[5]) >= Number(e[1]) && (e[2] === "" || Number(e[5]) < Number(e[2])) && Number(e[5]) < days * 1440);
  const window = new Map(evaluated.map((e) => [e[0], [Number(e[5]), Number(e[5]) + Number(e[6]) + WINDOW_AFTER_FULL_MIN]]));
  const inWin = (id: string, m: number) => { const w = window.get(id); return w !== undefined && m >= w[0] && m <= w[1]; };
  const leads: number[] = [];
  let withNew = 0, withAny = 0;
  for (const e of evaluated) {
    // A stay with no cohort row has no alert, as in the research package.
    const first = (alerts.get(e[0]) ?? []).find((m) => inWin(e[0], m));
    if (first !== undefined) { withNew += 1; leads.push(r4(Number(e[5]) + Number(e[6]) - first)); }
    if ((hits.get(e[0]) ?? []).some((m) => inWin(e[0], m))) withAny += 1;
  }
  leads.sort((a, b) => a - b);
  const mid = leads.length >> 1;
  const count = [...alerts.values()].reduce((a, f) => a + f.length, 0);
  return {
    alerts: count,
    alerts_per_patient: share(count, episodes.length),
    alerts_per_patient_per_12h_shift: share(count, patientDays * 2),
    episodes_evaluated: evaluated.length,
    episodes_with_new_alert: withNew,
    episodes_with_new_alert_share: share(withNew, evaluated.length),
    episodes_alerting_any_bin: withAny,
    episodes_alerting_any_bin_share: share(withAny, evaluated.length),
    alerts_outside_episode_windows: [...alerts].reduce((a, [id, f]) => a + f.filter((m) => !inWin(id, m)).length, 0),
    lead_minutes: leads,
    lead_median_minutes: leads.length === 0 ? null : r4(leads.length % 2 ? leads[mid] : (leads[mid - 1] + leads[mid]) / 2),
    bins,
    bins_alerting: [...hits.values()].reduce((a, h) => a + h.length, 0),
  };
}

export function compareW4(seed: number, days: number, baseline: string, change: string, trial = runTrial): CompareFiles {
  const [hitA, hitB] = [parseRule(baseline), parseRule(change)];
  if (baseline === change) refuse("change: same rule as the baseline");
  const run = () => trial({ scenario: { ...SCENARIO_V1, format_version: 1, name: "default" }, seed, days, scenarioSha256: "0".repeat(64), simCommit: "unknown", nodeMajor: nodeMajor() });
  // The rule is applied after the run and never fed back, so the arms share one cohort; the second run proves it is repeatable.
  const [one, two] = [run(), run()];
  const [h1, h2] = [sha(one["cohort.csv"]), sha(one["episodes.csv"])];
  if (h1 !== sha(two["cohort.csv"]) || h2 !== sha(two["episodes.csv"])) refuse("pairing broken: two runs of the same seed differ");
  const byPatient = new Map<string, Row[]>();
  for (const r of rescore(one["cohort.csv"])) byPatient.set(r.id, [...(byPatient.get(r.id) ?? []), r]);
  const episodes = rows(one["episodes.csv"]);
  const patientDays = (JSON.parse(one["summary.json"]) as { patient_days: number }).patient_days;
  const [a, b] = [w4Arm(byPatient, hitA, episodes, patientDays, days), w4Arm(byPatient, hitB, episodes, patientDays, days)];
  return render({
    mode: "w4", seed, days, baseline,
    change: { kind: "rule", name: change, fields: [{ path: "rule", baseline, change }] },
    pairing: {
      status: "one cohort for both arms", same_person_at_each_arrival: true,
      lines: [`one run serves both arms (the rule is applied after it), so the people, arrivals and true episodes are the same; a second run of the same seed gave the same cohort.csv sha256 ${h1} and episodes.csv sha256 ${h2}`],
    },
    arms: { baseline: a, change: b },
    notes: [
      "the outcome of a warning is not modelled on W4: a staff review does not change vitals and the rule is never fed back into the run, so a rule changes only alerts and their timing",
      "starting patients (admit minute 0) are in the alert burden; their episodes are not evaluated; p-001 has a scripted worsening that is not an episode",
      "lead = fully-in minute minus the first new alert in the window; positive means the alert came before the episode was fully in",
      `alerts re-arm after ${REARM_BINS} bins (4 h) not alerting; window = episode_start to fully in + ${WINDOW_AFTER_FULL_MIN} min (both are judgement values taken from BioSentry-Intelligence research/)`,
    ],
  }, diff(a, b), nodeMajor());
}

// ---- hospital ----

// Which scenario leaves each group copies from its file. The groups that change who is in the hospital at minute 0, or the arrival clock, are refused.
const GROUPS: Record<string, RegExp> = {
  staffing: /^(er\.(nurses|doctorsDay|doctorsNight)|units\.\w+\.nurses)$/,
  nurses: /^(er\.nurses|units\.\w+\.nurses)$/,
  doctors: /^er\.doctors(Day|Night)$/,
  transferOutAfterH: /^transferOutAfterH$/,
};
const UNPAIRED = ["beds", "startOccupancy", "arrivals"];
function groupTest(group: string): RegExp {
  if (UNPAIRED.includes(group)) refuse(`change: group ${group} is not paired (it changes the minute-0 residents or the arrival clock)`);
  return GROUPS[Object.hasOwn(GROUPS, group) ? group : ""] ?? refuse(`change: unknown group "${clean(group)}"; use staffing, nurses, doctors or transferOutAfterH`);
}

const firstDiff = (x: string[], y: string[]) => { for (let i = 0; i < Math.max(x.length, y.length); i += 1) if (x[i] !== y[i]) return i; return -1; };
const minuteOf = (...r: (string[] | undefined)[]) => Math.min(...r.map((e) => (e ? Number(e[0]) : Infinity)));

/** The pairing facts from two events.csv texts and the two minute-0 resident lists. A broken arrival clock, resident list or course offset refuses. */
export function pairEvents(a: string, b: string, residentsA: string[], residentsB: string[]) {
  const [A, B] = [rows(a), rows(b)];
  const clock = (r: string[][]) => r.filter((e) => (e[4] === "arrive" || e[4] === "turned_away") && Number(e[0]) > 0);
  const [ca, cb] = [clock(A), clock(B)];
  const c = firstDiff(ca.map((e) => e[0]), cb.map((e) => e[0]));
  if (c >= 0) refuse(`pairing broken: arrival minutes differ from minute ${minuteOf(ca[c], cb[c])}`);
  if (residentsA.join() !== residentsB.join()) refuse("pairing broken: the minute-0 residents differ");

  const lines: string[] = [];
  const [pa, pb] = [A.filter((e) => e[4] === "arrive"), B.filter((e) => e[4] === "arrive")];
  const p = firstDiff(pa.map((e) => `${e[0]}:${e[1]}:${e[7]}`), pb.map((e) => `${e[0]}:${e[1]}:${e[7]}`));
  lines.push(p < 0 ? `the same person arrives at each of the ${pa.length} arrival minutes`
    : `same arrival minutes; from minute ${minuteOf(pa[p], pb[p])} the person at ${pa.filter((e, i) => e[1] !== pb[i]?.[1] || e[7] !== pb[i]?.[7]).length} of ${pa.length} arrivals differs (a return or a turned-away arrival depends on the scenario)`);

  const course = (r: string[][]) => {
    const [dec, det] = [new Map<string, number>(), new Map<string, number>()];
    for (const e of r) {
      if (e[4] === "decide_admit") dec.set(`${e[1]}:${e[7]}`, Number(e[0]));
      else if (e[4] === "deteriorate") det.set(`${e[1]}:${e[7]}`, Number(e[0]));
    }
    return { dec, det };
  };
  const [ka, kb] = [course(A), course(B)];
  let same = 0, once = 0, unchecked = 0;
  for (const key of new Set([...ka.det.keys(), ...kb.det.keys()])) {
    if (!ka.det.has(key) || !kb.det.has(key)) once += 1;
    else if (ka.dec.has(key) !== kb.dec.has(key)) refuse(`pairing broken: person ${key.split(":")[0]} has an admit decision in one arm only`);
    else if (ka.dec.has(key)) {
      if (ka.det.get(key)! - ka.dec.get(key)! !== kb.det.get(key)! - kb.dec.get(key)!) refuse(`pairing broken: the course offset from the admit decision differs for person ${key.split(":")[0]}`);
      same += 1;
    } else unchecked += 1; // a minute-0 resident has no admit decision in the run
  }
  lines.push(`deterioration courses seen in both arms: ${same} with an equal offset from the admit decision, ${unchecked} with no admit decision in the run (not checked); courses recorded in one arm only: ${once} (where the person was at onset depends on the scenario)`);

  const e = firstDiff(A.map((r) => r.join(",")), B.map((r) => r.join(",")));
  const at = e < 0 ? null : minuteOf(A[e], B[e]);
  lines.push(at === null ? "event logs identical for the whole run (no differing event)" : `event logs identical before minute ${at}; the first differing event is at minute ${at}`);
  if (at !== null) lines.push(`outcomes after minute ${at} differ by design; cohorts are not identical after it`);
  lines.push("W4 inside the hospital is not paired once placements differ (W4 uses its own fixed seed, drawn in placement order)");
  const what = p < 0 ? "same minute-0 residents, arrival minutes and person at each arrival" : "same minute-0 residents and arrival minutes; the person at some arrivals differs";
  return { status: at === null ? `${what}; no event differs` : `partly paired (${what}; event logs differ from minute ${at})`, same_person_at_each_arrival: p < 0, lines };
}

const MEAN_SKIP = ["hour", "unit"];
function hourlyMeans(csv: string) {
  const [head, ...body] = csv.trimEnd().split("\n").map((l) => l.split(","));
  const out: Record<string, Record<string, number | null>> = {};
  for (const unit of new Set(body.map((r) => r[head.indexOf("unit")]))) {
    const mine = body.filter((r) => r[head.indexOf("unit")] === unit);
    out[unit] = Object.fromEntries(head.flatMap((col, i) => {
      if (MEAN_SKIP.includes(col)) return [];
      const xs = mine.map((r) => r[i]).filter((v) => v !== "").map(Number);
      return [[col, xs.length === 0 ? null : r4(xs.reduce((s, x) => s + x, 0) / xs.length)]];
    }));
  }
  return out;
}

/** Two parsed scenarios and the group that may differ. Every other leaf (name and note aside) must be equal, else it refuses. */
export function compareHospital(seed: number, days: number, a: Scenario, b: Scenario, group: string): CompareFiles {
  const inGroup = groupTest(group);
  const [la, lb] = [leaves(a), leaves(b)];
  for (const k of ["name", "note"]) { delete la[k]; delete lb[k]; }
  const differ = Object.keys(la).filter((k) => la[k] !== lb[k]);
  const outside = differ.filter((k) => !inGroup.test(k));
  if (outside.length > 0) refuse(`change: more than one thing differs (${outside.slice(0, 3).join(", ")})`);
  if (differ.length === 0) refuse(`change: group ${group} has the same values in both files`);

  const [ra, rb] = [runHospitalTrial(seed, a, days), runHospitalTrial(seed, b, days)];
  const pairing = pairEvents(ra.eventsCsv, rb.eventsCsv, createHospital(seed, a).people.map((p) => p.id), createHospital(seed, b).people.map((p) => p.id));
  const arm = (r: typeof ra) => {
    // The run header is already at the top of the report.
    const { scenario: _s, limits: _l, format_version: _f, synthetic: _y, seed: _e, days: _d, warm_up_days: _w, ...summary } = JSON.parse(r.summaryJson);
    return { summary, hourly_means: hourlyMeans(r.hourlyCsv) };
  };
  const [x, y] = [arm(ra), arm(rb)];
  return render({
    mode: "hospital", seed, days, baseline: a,
    change: { kind: "group", name: group, fields: differ.map((path) => ({ path, baseline: la[path], change: lb[path] })) },
    pairing, arms: { baseline: x, change: y },
    notes: [
      "synthetic hospital; the groups compared here keep the same minute-0 residents and the same arrival clock",
      "the effects shown are the simulator's assumptions, not evidence about a real hospital",
      `limits of the hospital model, from its summary.json: ${LIMITS}`,
    ],
  }, diff(x, y), nodeMajor());
}

// ---- command line ----

const nodeMajor = () => Number(process.versions.node.split(".")[0]);
const USAGE = "usage: compare --seed N --days N --baseline B --change C --out DIR";
const FLAGS = ["--seed", "--days", "--baseline", "--change", "--out"];

function parseArgs(argv: string[]): Record<string, string> {
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--change" && argv[i] in got) refuse("exactly one --change is allowed");
    if (!FLAGS.includes(argv[i]) || argv[i] in got || i + 1 >= argv.length) refuse(USAGE);
    got[argv[i]] = argv[i + 1];
  }
  if (FLAGS.some((f) => !(f in got))) refuse(USAGE);
  return got;
}
function whole(flag: string, text: string, min: number, max: number): number {
  const n = /^(0|[1-9]\d{0,15})$/.test(text) ? Number(text) : NaN;
  return n >= min && n <= max ? n : refuse(`${flag} must be a whole number from ${min} to ${max}`);
}
const lstatOrNull = (path: string) => { try { return lstatSync(path); } catch { return null; } };

function readScenario(path: string, which: string): Scenario {
  const bad = (why: string) => refuse(`${which}: ${why}`);
  let st: ReturnType<typeof statSync>, buf: Buffer | null = null;
  try {
    st = statSync(path);
    // Only a regular file is read: a pipe or device would hang.
    if (st.isFile() && st.size <= MAX_BYTES) buf = readFileSync(path);
  } catch {
    return bad(`cannot read the scenario file "${clean(path)}"`);
  }
  if (!st.isFile()) bad("the scenario path is not a regular file");
  if (buf === null || buf.length > MAX_BYTES) bad(`scenario: file is over ${MAX_BYTES / 1024} KB`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf!);
  } catch {
    return bad("scenario: not valid UTF-8");
  }
  try {
    return parseScenario(text);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    return bad(e.message.split("\n")[0].slice(0, 200).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "?"));
  }
}

/** Checks everything, runs both arms, and returns where the files go and what they hold. Writes nothing. */
export function compare(argv: string[]): { out: string; files: CompareFiles } {
  const a = parseArgs(argv);
  const seed = whole("--seed", a["--seed"], 0, 2 ** 31 - 1);
  const days = whole("--days", a["--days"], 1, 60);
  const out = resolve(a["--out"]);
  const [base, change] = [a["--baseline"], a["--change"]];
  const rules = [base, change].map((t) => t.startsWith("rule="));
  const eq = change.indexOf("=");
  if (rules[0] !== rules[1] || (!rules[1] && eq < 1)) refuse("--baseline and --change must both be rules or a scenario and a group");
  const group = change.slice(0, eq);
  const inGroup = rules[0] ? null : groupTest(group);
  if (lstatOrNull(out)) refuse("--out exists");
  const parent = lstatOrNull(dirname(out)) && statSync(dirname(out));
  if (!parent) refuse("--out: parent folder does not exist");
  else if (!parent.isDirectory()) refuse("--out: parent is not a folder");
  if (rules[0]) return { out, files: compareW4(seed, days, base.slice(5), change.slice(5)) };
  const baseline = readScenario(base, "baseline");
  const other = readScenario(change.slice(eq + 1), "change");
  const arm = structuredClone(baseline);
  for (const [path, v] of Object.entries(leaves(other))) {
    if (!inGroup!.test(path)) continue;
    const keys = path.split(".");
    keys.slice(0, -1).reduce((o, k) => o[k] as Json, arm as unknown as Json)[keys[keys.length - 1]] = v;
  }
  return { out, files: compareHospital(seed, days, baseline, arm, group) };
}

/** True when this module is the program being run, also when it was started through a symlink. */
function isMain(argv1: string | undefined, moduleUrl: string) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  try {
    const { out, files } = compare(process.argv.slice(2));
    mkdirSync(out); // not recursive: the parent was checked, and a folder that appeared since is not overwritten
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(`${out}/${name}`, text, { flag: "wx" });
    } catch (e) {
      rmSync(out, { recursive: true, force: true });
      throw e;
    }
    console.log(`compare: wrote ${out}`);
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`compare: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(`compare: failed: ${clean((e as Error).message)}`);
      process.exitCode = 1;
    }
  }
}
