import { FILES, read } from "./data";
import { Evaluations, Models, Pipeline, Registry, ResearchAgent, SectionBoundary, Simulator } from "./sections";

/** The page over a set of files (the tests pass their own). */
export function AnalyticsPage({ files }: { files: Record<string, string | undefined> }) {
  const d = read(files);
  return (
    <div className="analytics">
      <header className="topbar">
        <h1>Developer page</h1>
      </header>
      <p className="tag">Build records of the project. Synthetic, not validated.</p>
      {/* The dashboard's Pipeline and Research pages will move here later. */}
      <SectionBoundary title="Pipeline"><Pipeline d={d} /></SectionBoundary>
      <SectionBoundary title="Models"><Models d={d} /></SectionBoundary>
      <SectionBoundary title="Evaluations"><Evaluations d={d} /></SectionBoundary>
      <SectionBoundary title="Simulator"><Simulator d={d} /></SectionBoundary>
      <SectionBoundary title="Registry"><Registry d={d} /></SectionBoundary>
      <SectionBoundary title="Research agent"><ResearchAgent d={d} /></SectionBoundary>
    </div>
  );
}

export default function Analytics() {
  return <AnalyticsPage files={FILES} />;
}
