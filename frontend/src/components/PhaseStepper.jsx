import React from "react";
import { fmtEth, isZeroHash } from "../chain.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Six visible stages. The contract's Phase enum has five; the sixth is the
 * released flag on a settled round.
 */
export default function PhaseStepper({ state }) {
  if (!state) return null;
  const r = state.round;
  const stage = r.released ? 5 : r.phase;

  const sealed = state.members.filter((m) => !isZeroHash(m.commitment)).length;
  const opened = state.members.filter((m) => m.revealed).length;

  const steps = [
    ["Idle", r.id === 0 ? "awaiting enrolment" : "between rounds"],
    ["Deposit", `${r.depositCount} of ${state.config.groupSize} paid in`],
    ["Sealed bids", sealed ? `${sealed} committed` : "accepting commitments"],
    ["Opening", opened ? `${opened} opened` : "accepting openings"],
    ["Settled", r.winner !== ZERO ? `${fmtEth(r.winningBid)} ETH won` : "auction closed"],
    ["Released", `${r.approvalCount} of ${state.config.requiredApprovals} approvals`],
  ];

  return (
    <div className="card">
      <div className="flowbar">
        {steps.map(([k, v], i) => (
          <div key={k} className={`step${i < stage ? " done" : ""}${i === stage ? " now" : ""}`}>
            <div className="k"><span className="bead" />{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
