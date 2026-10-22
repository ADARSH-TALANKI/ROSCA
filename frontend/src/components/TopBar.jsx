import React from "react";
import { fmtEth, PHASES } from "../chain.js";

export default function TopBar({ connected, state, blockNumber }) {
  const r = state?.round;
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">₹</div>
        <div>
          <div className="brand-title">Trust-Minimized Chit Fund</div>
          <div className="brand-sub">Sealed, descending, jointly custodied</div>
        </div>
      </div>

      <div className="topbar-spacer" />

      <div className="readout">
        <div className="read">
          <span className="k">Chain</span>
          <span className="v">
            <span className={`pulse ${connected ? "on" : "off"}`} />
            {connected ? `block ${blockNumber}` : "unreachable"}
          </span>
        </div>
        {r && (
          <>
            <div className="read">
              <span className="k">Round</span>
              <span className="v">{r.id || "not started"}</span>
            </div>
            <div className="read">
              <span className="k">Phase</span>
              <span className="v cyan">
                {PHASES[r.phase]}
                {r.phase === 2 || r.phase === 3
                  ? ` ${r.biddingRound}/${r.maxBiddingRounds}`
                  : ""}
              </span>
            </div>
            <div className="read">
              <span className="k">Standing bid</span>
              <span className="v brass">
                {r.standingBid > 0n ? `${fmtEth(r.standingBid)} ETH` : "none yet"}
              </span>
            </div>
            <div className="read">
              <span className="k">In escrow</span>
              <span className="v brass">{fmtEth(r.contractBalance)} ETH</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
