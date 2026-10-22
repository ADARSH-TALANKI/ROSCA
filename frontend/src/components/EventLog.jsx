import React, { useEffect, useRef } from "react";

export default function EventLog({ entries, onClear }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [entries.length]);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Chain activity</h3>
        <div className="spacer" />
        <span className="tag">{entries.length}</span>
        <button className="btn ghost sm" onClick={onClear}>clear</button>
      </div>
      <div className="log" ref={ref}>
        {entries.length === 0 && (
          <div className="empty">
            Nothing yet. Every transaction, revert and contract event lands here.
          </div>
        )}
        {entries.map((e) => (
          <div className={`log-row ${e.tone || ""}`} key={e.id}>
            <span className="t">{e.at}</span>
            <span className="m">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
