import { Component, type ReactNode } from "react";
import { Sparkline } from "../chart";
import type { Cell, Curve, Data, Src, Table } from "./data";

const NONE = "not on main yet";
const MAX_ROWS = 50;

export const Tag = () => <p className="tag">synthetic, not validated</p>;

/** One panel. If its body throws, it shows "could not show" and the other panels stay. */
export class SectionBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return (
      <section className="panel">
        <h2>{this.props.title}</h2>
        <Tag />
        {this.state.failed ? <p>could not show</p> : this.props.children}
      </section>
    );
  }
}

const cell = (c: Cell) => (typeof c === "string" ? c : Array.isArray(c) ? <ul>{c.map((l, i) => <li key={i}>{l}</li>)}</ul> : <code>{c.code}</code>);

export function Tbl({ t }: { t: Table }) {
  return (
    <div className="scroll">
      <table>
        <caption>
          {t.lead && (
            <>
              <span className="tag">{t.lead}</span>
              <br />
            </>
          )}
          {t.caption}
        </caption>
        <thead>
          <tr>{t.head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {t.rows.slice(0, MAX_ROWS).map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (j === 0 ? <th key={j} scope="row">{cell(c)}</th> : <td key={j}>{cell(c)}</td>))}
            </tr>
          ))}
          {t.rows.length > MAX_ROWS && (
            <tr>
              <td colSpan={t.head.length}>more rows not shown</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const Prov = ({ s }: { s: Src<unknown> | null }) =>
  s && (
    <p>
      {s.line.prefix}from {s.line.repo} at <code>{s.line.commit}</code>, {s.line.date}
    </p>
  );

const Missing = ({ what }: { what: string }) => <p>{what}: {NONE}</p>;
const Lines = ({ items }: { items: string[] }) => <ul>{items.map((l, i) => <li key={i}>{l}</li>)}</ul>;

function Chart({ c }: { c: Curve }) {
  return (
    <p>
      <Sparkline data={c.ys} /> {c.label}, last {c.last}
      {c.thinned && ", curve thinned"}
    </p>
  );
}

/** A section none of whose files is usable. */
const Empty = () => <p>{NONE}</p>;

export function Pipeline({ d }: { d: Data }) {
  return d.pipeline ? (
    <>
      <Prov s={d.pipeline} />
      <Tbl t={d.pipeline.v.table} />
    </>
  ) : (
    <Empty />
  );
}

const MODELS: [string, string, string][] = [
  ["tier_a/news2", "news2", "models/tier_a/news2/card.md"],
  ["tier_b/baseline", "baseline", "models/tier_b/baseline/card.md"],
  ["tier_b/reward_policy", "reward", "models/tier_b/reward_policy/card.md"],
  ["tier_c/confidence_check", "confidence", "models/tier_c/confidence_check/card.md"],
  ["tier_c/student_vitals", "prediction", "models/tier_c/student_vitals/card.md"],
  ["agent", "agent", "models/agent/card.md"],
];

function ModelBody({ id, d }: { id: string; d: Data }) {
  if (id === "tier_a/news2") return <p>no model file</p>;
  if (id === "tier_b/baseline")
    return d.baseline ? (
      <>
        <Prov s={d.baseline} />
        <p>{d.baseline.v.line}</p>
        <p>{d.baseline.v.chosen}</p>
      </>
    ) : (
      <Missing what="Baseline params" />
    );
  if (id === "tier_b/reward_policy") {
    const rows = [d.rewardAll && ["all", d.rewardAll.v.cells] as const, d.rewardNo && ["no temperature", d.rewardNo.v.cells] as const].filter((x) => x !== null && x !== undefined);
    return (
      <>
        <Prov s={d.rewardAll} />
        <Prov s={d.rewardNo} />
        {rows.length > 0 ? (
          <Tbl t={{ caption: "Policies", head: ["Variant", "Round", "Chosen generation", "Lambda", "p", "theta", "Validation reward", "Seeds", "Stop"], rows: rows.map(([v, cells]) => [v, ...cells]) }} />
        ) : (
          <Missing what="Policies" />
        )}
        <Prov s={d.rewardRun} />
        {d.rewardRun ? <p>{d.rewardRun.v.line}</p> : <Missing what="Run log" />}
      </>
    );
  }
  if (id === "tier_c/confidence_check") {
    const rows = [d.calibAll, d.calibNo].filter((x) => x !== null);
    return (
      <>
        <Prov s={d.calibAll} />
        <Prov s={d.calibNo} />
        <Prov s={d.confRun} />
        {rows.length > 0 ? (
          <>
            <Tbl t={{ caption: "Calibration", head: ["Variant", "alpha", "q", "t", "n", "k", "j", "days", "speed", "negative bins", "binding"], rows: rows.map((r) => [...r.v.cells, d.confRun?.v.get(r.v.cells[0]) ?? NONE]) }} />
            <Lines items={rows.map((r) => `${r.v.cells[0]}: ${r.v.seeds}`)} />
          </>
        ) : (
          <Missing what="Calibration" />
        )}
        <Prov s={d.heldOut} />
        {d.heldOut && d.heldOut.v.verdicts.size > 0 ? <Lines items={[...d.heldOut.v.verdicts].map(([v, w]) => `held-out ${v}: ${w}`)} /> : <Missing what="held-out" />}
      </>
    );
  }
  if (id === "tier_c/student_vitals")
    return (
      <>
        <Prov s={d.studentRun} />
        <Prov s={d.studentMeta} />
        {d.studentRun ? (
          <p>
            {d.studentRun.v.line}, run commit <code>{d.studentRun.v.commit}</code>
          </p>
        ) : (
          <Missing what="Run log" />
        )}
        {d.studentMeta ? <Tbl t={d.studentMeta.v} /> : <Missing what="Student" />}
        {d.studentRun && d.studentRun.v.curves.length > 0 ? d.studentRun.v.curves.map((c, i) => <Chart key={i} c={c} />) : <Missing what="Curves" />}
      </>
    );
  return (
    <>
      <p>no model file</p>
      <Prov s={d.agentRun} />
      {d.agentRun ? d.agentRun.v.curves.map((c, i) => <Chart key={i} c={c} />) : <Missing what="Run log" />}
    </>
  );
}

export function Models({ d }: { d: Data }) {
  const any = [d.manifest, d.baseline, d.rewardAll, d.rewardNo, d.rewardRun, d.calibAll, d.calibNo, d.confRun, d.heldOut, d.studentMeta, d.studentRun, d.agentRun].some((x) => x !== null);
  if (!any) return <Empty />;
  return (
    <>
      <Prov s={d.pipeline} />
      {MODELS.map(([id, stage, card]) => (
        <div key={id}>
          <h3>{id}</h3>
          <p>state: {d.pipeline?.v.states.get(stage) ?? NONE}</p>
          <p>card: {card}</p>
          <ModelBody id={id} d={d} />
        </div>
      ))}
    </>
  );
}

export function Evaluations({ d }: { d: Data }) {
  const e = d.evaluations;
  const policies = [["all", d.rewardAll, d.rewardRun] as const, ["no temperature", d.rewardNo, d.rewardRun] as const].filter(([, p]) => p !== null);
  if (!e && policies.length === 0 && !d.agentRun) return <Empty />;
  return (
    <>
      <Prov s={e} />
      {e?.v.context ? (
        <>
          <p>{e.v.context.line}</p>
          <Lines items={e.v.context.texts} />
        </>
      ) : (
        <Missing what="Context" />
      )}
      {e?.v.rules ? <Tbl t={e.v.rules} /> : <Missing what="Rules" />}
      <Missing what="Confidence" />
      <Prov s={d.rewardAll} />
      <Prov s={d.rewardNo} />
      <Prov s={d.rewardRun} />
      {policies.length > 0 ? policies.map(([name, p]) => <Chart key={name} c={{ ...p!.v.curve, label: `${name}, validation reward` }} />) : <Missing what="Reward loop" />}
      {d.rewardRun ? <Tbl t={d.rewardRun.v.table} /> : <Missing what="Generations" />}
      <Prov s={d.agentRun} />
      {d.agentRun?.v.table ? <Tbl t={d.agentRun.v.table} /> : <Missing what="Agent tuning" />}
    </>
  );
}

export function Simulator({ d }: { d: Data }) {
  const s = d.simulator;
  if (!s) return <Empty />;
  const { realism, compare, outcome } = s.v;
  return (
    <>
      <Prov s={s} />
      <p>node {s.v.node}</p>
      {realism ? (
        <>
          <Tbl t={realism.table} />
          <Lines items={realism.notes} />
        </>
      ) : (
        <Missing what="Realism" />
      )}
      {compare ? (
        <>
          <p>{compare.line}</p>
          {compare.tables.map((t) => <Tbl key={t.caption} t={t} />)}
          <Lines items={compare.notes} />
        </>
      ) : (
        <Missing what="Compare" />
      )}
      {outcome ? (
        <>
          <p className="tag">{outcome.label}</p>
          <Lines items={outcome.lines} />
          {outcome.tables.map((t) => <Tbl key={t.caption} t={t} />)}
          <p>{outcome.cost}</p>
          <Lines items={outcome.notes} />
        </>
      ) : (
        <Missing what="Outcome" />
      )}
    </>
  );
}

export function Registry({ d }: { d: Data }) {
  if (!d.registry && !d.manifest) return <Empty />;
  return (
    <>
      <Prov s={d.registry} />
      {d.registry ? (
        <>
          <Tbl t={d.registry.v.datasets} />
          <Tbl t={d.registry.v.weights} />
        </>
      ) : (
        <Missing what="Datasets" />
      )}
      <Prov s={d.manifest} />
      {d.manifest ? <Tbl t={d.manifest.v.table} /> : <Missing what="Model files" />}
    </>
  );
}

export function ResearchAgent({ d }: { d: Data }) {
  const a = d.agent;
  if (!a) return <Empty />;
  return (
    <>
      <Prov s={a} />
      <p>{a.v.records}</p>
      <p>
        ledger sha256 <code>{a.v.sha}</code>
      </p>
      <Tbl t={a.v.questions} />
      <Tbl t={a.v.proposals} />
      {a.v.scores ? <Tbl t={a.v.scores} /> : <Missing what="Scores" />}
    </>
  );
}
