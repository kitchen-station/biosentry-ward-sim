import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANNED, load, type Kind } from "./data";

const ROOT = new URL("../data/evaluation/", import.meta.url);
const EXPORTED = "frontend/src/data/evaluation/";
const record = JSON.parse(readFileSync(new URL("sync.json", ROOT), "utf8")) as { repo: string; commit: string; commit_date: string; files: { path: string; bytes: number; sha256: string }[] };
const copyOf = (path: string) => (path.startsWith(EXPORTED) ? path.slice(EXPORTED.length) : `repo/${path}`);

const onDisk = (base = ""): string[] =>
  readdirSync(new URL(base, ROOT), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? onDisk(`${base}${e.name}/`) : e.name.endsWith(".json") ? [`${base}${e.name}`] : []));

describe("sync.json", () => {
  it("is the record of the copies: same bytes, same sha256, nothing else on disk", () => {
    expect(record.repo).toBe("kitchen-station/BioSentry-Intelligence");
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.commit_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const f of record.files) {
      const bytes = readFileSync(new URL(copyOf(f.path), ROOT));
      expect(bytes.length, f.path).toBe(f.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), f.path).toBe(f.sha256);
    }
    expect(onDisk().filter((p) => p !== "sync.json").sort()).toEqual(record.files.map((f) => copyOf(f.path)).sort());
    expect(record.files.map((f) => f.path)).toEqual(record.files.map((f) => f.path).sort());
  });

  it("holds files that all pass the page's checks", () => {
    const text = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
    const ids = (folder: string) => onDisk().filter((p) => p.startsWith(`repo/training/runs/${folder}/`)).map((p) => p.split("/").pop()!.replace(/\.json$/, ""));
    expect(load("sync", text("sync.json")).state).toBe("ok");
    for (const f of record.files) {
      const path = copyOf(f.path);
      const by: [RegExp, Kind, string?][] = [
        [/^pipeline\.json$/, "pipeline"],
        [/^evaluations\.json$/, "evaluations"],
        [/^simulator\.json$/, "simulator"],
        [/^registry\.json$/, "registry"],
        [/^research-agent\.json$/, "agent"],
        [/models\/manifest\.json$/, "manifest"],
        [/baseline\/params\.json$/, "baseline"],
        [/reward_policy\/policy\.json$/, "policy", "tier_b/reward_policy"],
        [/no_temperature\/policy\.json$/, "policy", "tier_b/reward_policy/no_temperature"],
        [/calibration\.json$/, "calibration", "all"],
        [/calibration_no_temp\.json$/, "calibration", "no_temp"],
        [/heldout\.json$/, "heldOut"],
        [/student_vitals\/metadata\.json$/, "studentMeta"],
        [/runs\/student_vitals\//, "studentRun", path.split("/").pop()!.replace(/\.json$/, "")],
        [/runs\/reward_policy\//, "rewardRun", path.split("/").pop()!.replace(/\.json$/, "")],
        [/runs\/confidence_check\//, "confidenceRun", path.split("/").pop()!.replace(/\.json$/, "")],
        [/agent\/runs\/run1\.json$/, "agentRun"],
        [/agent\/runs\/run1\.scores\.json$/, "agentScores"],
      ];
      const hit = by.find(([re]) => re.test(path));
      expect(hit, `no loader for ${path}`).toBeTruthy();
      const r = load(hit![1], text(path), hit![2]);
      expect(r.state === "invalid" ? `${path}: ${r.why}` : r.state, path).toBe("ok");
    }
    expect(ids("student_vitals").length).toBeGreaterThan(0);
  });

  it("holds no banned claim in an exported file", () => {
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    for (const f of record.files.filter((x) => x.path.startsWith(EXPORTED)))
      for (const s of strings(JSON.parse(readFileSync(new URL(copyOf(f.path), ROOT), "utf8")))) expect(BANNED.test(s), `${f.path}: ${s}`).toBe(false);
  });
});
