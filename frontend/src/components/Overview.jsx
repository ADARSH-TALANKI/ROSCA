import React from "react";
import { Card, Stat, Banner, KV, Pill } from "./ui.jsx";
import { fmtEth, PHASES, short } from "../chain.js";

const GAPS = [
  {
    id: "G1",
    name: "Auction integrity",
    found: "Every reviewed design writes the bid amount into state in the clear, so the last bidder to act always wins.",
    ours: "Multi-round commit-reveal. The amount is absent from state until its round is opened, the opening is bound to the bidder\u2019s address, and the standing bid is published between rounds so the auction can actually find a price.",
    where: "commitBid() / revealBid() / closeBiddingRound()",
  },
  {
    id: "G2",
    name: "Default handling",
    found: "Defaults are either ignored or answered with collateral large enough to exclude the unbanked subscribers the papers claim to serve.",
    ours: "Arrears are tracked per member, dividends are diverted to cover them, and three misses mark a default against the nullifier. Bounded, not solved.",
    where: "openBidding() / releasePayout()",
  },
  {
    id: "G3",
    name: "Sybil resistance",
    found: "Identity is the wallet address, so one person can hold several seats; one paper puts the Aadhaar number itself on a public chain.",
    ours: "The registrar verifies documents off-chain and submits only keccak256(document ‖ platformSalt). One person, one seat, no identifier on chain.",
    where: "registerMember()",
  },
  {
    id: "G4",
    name: "Custody",
    found: "The operator can move the escrow on its own signature, which reproduces exactly the offline foreman risk the work set out to remove.",
    ours: "2-of-3 approval across registrar, operator and auditor. With three approvers, every valid quorum contains a non-operator.",
    where: "approvePayout() / releasePayout()",
  },
];

export default function Overview({ state, cfg }) {
  const r = state.round;
  const c = state.config;
  const registered = state.members.filter((m) => m.registered).length;
  const defaulted = state.members.filter((m) => m.defaulted).length;
  const arrears = state.members.reduce((a, m) => a + m.arrears, 0n);

  return (
    <div className="stack">
      <Banner tone="info" icon="◆">
        <b>What this is.</b> A working chit fund on a local Ethereum chain, built so that the four
        weaknesses identified in the literature review can be demonstrated rather than asserted.
        Switch persona in the bar above, drive a round through the <b>Auction</b> and{" "}
        <b>Settlement</b> tabs, then open the <b>Attack Lab</b> to watch each attack succeed against
        the prior art and fail here.
      </Banner>

      <div className="card">
        <div className="stats">
          <Stat k="Chit value" v={`${fmtEth(BigInt(cfg.contribution) * BigInt(cfg.groupSize))} ETH`}
                s={`${fmtEth(cfg.contribution)} ETH × ${cfg.groupSize} subscribers`} />
          <Stat k="Enrolled" v={`${registered}/${c.groupSize}`} s="by nullifier" tone={registered === c.groupSize ? "accent" : undefined} />
          <Stat k="Round" v={r.id} s={PHASES[r.phase]} />
          <Stat k="In escrow" v={`${fmtEth(r.contractBalance)} ETH`} s="held by the contract" tone="accent" />
          <Stat k="Quorum" v={`${r.approvalCount}/${c.requiredApprovals}`} s="of 3 organisations" />
          <Stat k="Discount cap" v={`${c.maxDiscountBps / 100}%`} s="Chit Funds Act 1982" />
          <Stat k="Arrears" v={`${fmtEth(arrears)} ETH`} s="outstanding" tone={arrears > 0n ? "warn" : undefined} />
          <Stat k="Defaults" v={defaulted} s={`after ${c.defaultThreshold} misses`} tone={defaulted > 0 ? "bad" : undefined} />
        </div>
      </div>

      <div className="grid wide-left">
        <Card title="One round, end to end" tag="lifecycle"
              sub="Who acts, what the chain learns at each step, and what it still cannot see.">
          <div className="flow">
            {[
              ["Enrolment", "Registrar of Chits",
               "Documents are checked off-chain. The contract receives a 32-byte nullifier and nothing else. A second wallet for the same person produces the same nullifier and is rejected."],
              ["Deposit", "Each subscriber",
               `Every member pays exactly ${fmtEth(cfg.contribution)} ETH into the contract. The pot is the sala for this month.`],
              ["Sealed bidding", "Each subscriber",
               "A member submits keccak256(amount ‖ salt ‖ her address). The amount is not on the chain in any form, so there is nothing for a rival to read."],
              ["Opening", "Each subscriber",
               "Openings are checked against the stored hash and against the 30% statutory ceiling. A bidder cannot change her number after seeing someone else's."],
              ["Publish and repeat", "ChitCo",
               "The standing lowest bid is published and a fresh sealed round opens, up to three in all. A later bid must come in strictly below the standing one, so the auction descends and terminates. If a round attracts no improvement it settles there."],
              ["Auction close", "ChitCo",
               "The lowest lawful bid takes the pot. Tied bids go to a draw; a round with no reveals falls back to a lottery, as the Act permits."],
              ["Approval", "Any two of three organisations",
               "Registrar, ChitCo and auditor each hold one approval. Two are needed, so the operator can never release funds alone."],
              ["Release", "Anyone, once quorum holds",
               "The prized subscriber is paid. The discount is shared as dividend among the others, with arrears deducted first."],
            ].map(([t, who, body], i) => {
              const stage = r.released ? 6 : r.phase === 0 ? (registered < c.groupSize ? 0 : 1) : r.phase;
              const idx = i;
              return (
                <React.Fragment key={t}>
                  {i > 0 && <div className="flow-arrow">↓</div>}
                  <div className={`flow-node ${idx < stage ? "done" : ""} ${idx === stage ? "active" : ""}`}>
                    <div className="fh">
                      <span className="fn">{i + 1}</span>
                      <b>{t}</b>
                      <div className="spacer" style={{ flex: 1 }} />
                      <Pill tone="teal">{who}</Pill>
                    </div>
                    <p>{body}</p>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </Card>

        <div className="stack">
          <Card title="Deployment" tag="localhost">
            <KV rows={[
              ["ChitFund", <span className="mono" title={cfg.chitFund}>{short(cfg.chitFund, 6)}</span>],
              ["NaiveChitFund", <span className="mono" title={cfg.naiveChitFund}>{short(cfg.naiveChitFund, 6)}</span>],
              ["Registrar", <span className="mono">{short(c.registrar, 6)}</span>],
              ["ChitCo", <span className="mono">{short(c.chitCo, 6)}</span>],
              ["Auditor", <span className="mono">{short(c.auditor, 6)}</span>],
              ["Chain id", cfg.chainId],
            ]} />
            <div style={{ height: 12 }} />
            <div className="note">
              <b>NaiveChitFund</b> is a deliberately vulnerable reconstruction of the reviewed
              designs. It exists so the attacks can be shown landing on prior art instead of
              being described in a slide.
            </div>
          </Card>

          <Card title="Known limitations" tag="honest">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-2)", lineHeight: 1.65 }}>
              <li>The fiat leg is out of scope. Contributions are ETH on a local chain.</li>
              <li>Tied bids are drawn from the revealed salts, so operator timing cannot steer them. The empty-auction lottery still uses <code className="plain">block.prevrandao</code> and stays demo-grade.</li>
              <li>Default risk is bounded, not solved. A late default still costs the group.</li>
              <li>The registrar is trusted to derive the nullifier honestly. A zero-knowledge proof of document possession removes that trust and is next semester's work.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Card title="Literature gaps and what answers them" tag="G1 – G4"
            sub="Each row is a specific flaw in a specific reviewed design, with the mechanism that addresses it.">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 44 }}>Gap</th>
                <th style={{ width: 150 }}>Concern</th>
                <th>What the reviewed work does</th>
                <th>What this design does</th>
                <th style={{ width: 170 }}>Where</th>
              </tr>
            </thead>
            <tbody>
              {GAPS.map((g) => (
                <tr key={g.id}>
                  <td><Pill tone="teal">{g.id}</Pill></td>
                  <td><b>{g.name}</b></td>
                  <td className="muted">{g.found}</td>
                  <td>{g.ours}</td>
                  <td><code className="plain">{g.where}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
