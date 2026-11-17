/** What the page shows while it waits for the server: the shell stays, the stage and side panel are skeleton blocks. */
export function WardSkeleton({ label = "Loading the hospital" }: { label?: string }) {
  return (
    <div className="shell skel" role="status" aria-busy="true">
      <span className="hw-visually-hidden">{label}</span>
      <div className="skel__bar" aria-hidden="true">
        <span className="hw-skeleton hw-skeleton--title" />
        <span className="hw-skeleton skel__chip" />
        <span className="hw-skeleton skel__chip" />
      </div>
      <div className="wardmain skel__stage" aria-hidden="true">
        <span className="hw-skeleton skel__building" />
        <span className="hw-skeleton skel__line" />
      </div>
      <aside className="wardside skel__side" aria-hidden="true">
        <span className="hw-skeleton hw-skeleton--title" />
        <span className="hw-skeleton skel__line" />
        <span className="hw-skeleton skel__line" />
        <span className="hw-skeleton skel__tile" />
      </aside>
    </div>
  );
}

/** A small block for one panel that waits on the server. */
export function PanelSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="skel__panel">
      <span className="hw-visually-hidden">{label}</span>
      <span className="hw-skeleton hw-skeleton--title" aria-hidden="true" />
      <span className="hw-skeleton skel__line" aria-hidden="true" />
      <span className="hw-skeleton skel__line" aria-hidden="true" />
    </div>
  );
}
