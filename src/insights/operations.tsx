// The Hospital operations panel while the page watches the server. It prints the counts it is given (src/open-ops.ts makes
// them from the server's public view) and, beside each line a count is read against, what kind of source that line is.
// It holds no patient, no name and no bed: a watcher who is not signed in may see it.
/** The operations numbers of a hospital the page watches. Typed here so the page imports nothing from the engine. */
export interface OpsView {
  units: { id: string; name: string; floor: number; inUse: number | null; beds: number; pct: number | null; flag: string | null; high: number | null; medium: number | null }[];
  inUse: number; beds: number; pct: number | null; flag: string | null; issues: string[];
  /** The lines a number is read against, each with what kind of source it is. */
  tags: { occupancy: string; icu: string; er: string; high: string };
}
/** What the server does not send, and what each would be read against. No number of ours stands in for any of them. */
const OPS_NOT_SERVED = [
  "Nurses on duty and patients per nurse. Read against 1 nurse to 12 patients (DOH guideline, source not confirmed) and, from California Title 22 (a law of one US state), 1 to 5 on a medical or surgical ward, 1 to 2 in intensive care and 1 to 4 in an emergency room.",
  "Emergency room: patients waiting, patients boarding and the longest wait. Boarding is the time from the decision to admit to leaving the emergency room (ACEP definition, a guideline; it sets no limit).",
  "Patients waiting for an intensive care bed.",
  "Patients placed outside their own department.",
  "Transfers and deaths in the last 24 hours.",
];

export function Operations({ ops }: { ops: OpsView }) {
  const cell = (n: number | null) => (n === null ? "none" : n);
  return (
    <section className="ops" aria-label="Hospital operations now">
      <h4>Operations now</h4>
      <p className="tiny">Counted from the server's public view: beds in use and NEWS2 bands. Bed counts are this page's copy of the simulator's unit table; the server does not send them. Synthetic data.</p>
      <div className="numbers">
        <table>
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">In use</th>
              <th scope="col">Beds</th>
              <th scope="col">In use, %</th>
              <th scope="col">NEWS2 7 or more</th>
              <th scope="col">NEWS2 5 or 6</th>
            </tr>
          </thead>
          <tbody>
            {ops.units.map((u) => (
              <tr key={u.id}>
                <th scope="row">{u.floor === 0 ? "GF" : `${u.floor}F`} {u.name}</th>
                <td>{u.inUse === null ? "no answer yet" : u.inUse}</td>
                <td>{u.beds}</td>
                <td>{u.pct === null ? "none" : <>{u.pct}%{u.flag && <b> ({u.flag})</b>}</>}</td>
                <td>{u.high === null ? "not scored" : cell(u.high)}</td>
                <td>{u.medium === null ? "not scored" : cell(u.medium)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Inpatient beds in use: {ops.inUse} of {ops.beds}{ops.pct !== null && <>, {ops.pct}%</>}{ops.flag && <b> ({ops.flag})</b>}. The emergency room is counted against its bays and is not in this total.
      </p>
      <h4>Issues now</h4>
      {ops.issues.length === 0 ? (
        <p>None in what the server sends.</p>
      ) : (
        <ul aria-label="Issues now">
          {ops.issues.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      <h4>What each number is read against</h4>
      <ul aria-label="What each number is read against">
        <li>Ward beds in use: above 85%, and 90% or more. {ops.tags.occupancy}.</li>
        <li>Intensive care beds in use: 60% moderate, 70% high, 85% critical. {ops.tags.icu}.</li>
        <li>Emergency room, {ops.tags.er}.</li>
        <li>NEWS2 on a ward. {ops.tags.high}.</li>
      </ul>
      <h4>Not served</h4>
      <ul aria-label="Not served">
        {OPS_NOT_SERVED.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}
