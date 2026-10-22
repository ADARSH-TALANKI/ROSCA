import React from "react";
import { Avatar } from "./ui.jsx";
import { short, isZeroHash } from "../chain.js";

export default function ActorBar({ actors, current, onPick, state }) {
  const byAddr = {};
  (state?.members || []).forEach((m) => { byAddr[m.addr.toLowerCase()] = m; });
  const roundLive = (state?.round?.phase ?? 0) !== 0;
  const bidding = state?.round?.phase === 2 || state?.round?.phase === 3;

  const flagsFor = (a) => {
    if (a.kind === "org") return [["violet", a.key === "chitCo" ? "operator" : "approver"]];
    if (a.kind === "outsider") return [["bad", "no role"]];
    const m = byAddr[a.address.toLowerCase()];
    if (!m || !m.registered) return [["gray", "not enrolled"]];

    const f = [];
    if (m.isStanding) f.push(["brass", "leading"]);
    if (m.defaulted) f.push(["bad", "defaulted"]);
    if (m.hasWon) f.push(["violet", "prized"]);
    if (roundLive) {
      if (m.deposited) f.push(["ok", "paid"]);
      else if (!m.defaulted) f.push(["warn", "unpaid"]);
    }
    if (bidding) {
      if (m.revealed) f.push(["brass", "opened"]);
      else if (!isZeroHash(m.commitment)) f.push(["cyan", "sealed"]);
    }
    return f.length ? f : [["gray", "enrolled"]];
  };

  return (
    <div className="actors">
      {actors.map((a) => (
        <button
          key={a.key}
          className={`actor${current === a.key ? " on" : ""}`}
          onClick={() => onPick(a.key)}
          title={a.blurb}
        >
          <div className="top">
            <Avatar actor={a} size={26} />
            <div style={{ minWidth: 0 }}>
              <div className="nm">{a.label}</div>
              <div className="rl">{a.role}</div>
            </div>
          </div>
          <div className="ad">{short(a.address)}</div>
          <div className="flags">
            {flagsFor(a).map(([tone, text], i) => (
              <span className={`pill ${tone}`} key={i}>{text}</span>
            ))}
          </div>
        </button>
      ))}
    </div>
  );
}
