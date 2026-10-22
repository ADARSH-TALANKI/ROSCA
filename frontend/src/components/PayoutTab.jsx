import React from "react";
import { Card, Banner, Pill, Who, Stat, KV } from "./ui.jsx";
import { chitAs, fmtEth, short, PHASES } from "../chain.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export default function PayoutTab({ state, cfg, actor, actors, tx }) {
  const r = state.round;
  const c = state.config;

  const orgs = [
    { key: "registrar", label: "Registrar of Chits", addr: c.registrar, approved: r.registrarApproved,
      why: "Confirms the prized subscriber is an enrolled person in good standing." },
    { key: "chitCo", label: "ChitCo", addr: c.chitCo, approved: r.chitCoApproved,
      why: "Confirms the auction ran to its own rules. One vote only, never a majority." },
    { key: "auditor", label: "Independent Auditor", addr: c.auditor, approved: r.auditorApproved,
      why: "Confirms the arithmetic. Issues no credentials and takes no custody." },
  ];

  const settled = r.phase === 4;
  const quorum = r.approvalCount >= c.requiredApprovals;
  const winnerActor = actors.find((a) => a.address.toLowerCase() === r.winner.toLowerCase());
  const nonWinners = Math.max(state.members.length - 1, 0);
  const share = nonWinners > 0 ? r.discount / BigInt(nonWinners) : 0n;
  const myOrg = orgs.find((o) => o.key === actor.key);

  const asOrg = (label, fn, opts) =>
    tx(label, async () => fn(await chitAs(actor.address)), opts);

  return (
    <div className="stack">
      {!settled && !r.released && (
        <Banner tone="warn" icon="!">
          The auction for round {r.id || 1} has not closed yet (current phase:{" "}
          <b>{PHASES[r.phase]}</b>). Approvals only become available once a winner exists, which is
          deliberate: there is nothing to approve before then.
        </Banner>
      )}

      <div className="card">
        <div className="stats">
          <Stat k="Prized subscriber" v={r.winner === ZERO ? "—" : (winnerActor?.label || short(r.winner))}
                s={r.winner === ZERO ? "not decided" : "lowest lawful bid"} tone="accent" />
          <Stat k="Paid to winner" v={`${fmtEth(r.winningBid)} ETH`} s="the prize" />
          <Stat k="Discount" v={`${fmtEth(r.discount)} ETH`} s="shared as dividend" />
          <Stat k="Dividend each" v={`${fmtEth(share)} ETH`} s={`${nonWinners} non-winners`} />
          <Stat k="Approvals" v={`${r.approvalCount}/${c.requiredApprovals}`}
                s={quorum ? "quorum reached" : "quorum short"} tone={quorum ? "accent" : "warn"} />
          <Stat k="Released" v={r.released ? "yes" : "no"} s={r.released ? "funds moved" : "funds held"}
                tone={r.released ? "accent" : undefined} />
        </div>
      </div>

      <div className="grid sidebar">
        <div className="stack">
          <Card title="Distributed authority" tag="G4"
                sub={`${c.requiredApprovals} of 3 organisations must approve before any value moves.`}>
            <div className="quorum">
              <i style={{ width: `${Math.min(100, (r.approvalCount / c.requiredApprovals) * 100)}%` }} />
            </div>
            <div className="approvals">
              {orgs.map((o) => (
                <div className={`appr ${o.approved ? "yes" : ""}`} key={o.key}>
                  <span className="box">✓</span>
                  <div className="t">
                    <b>{o.label}</b>
                    <div>{o.why}</div>
                  </div>
                  <code className="plain nowrap">{short(o.addr)}</code>
                  {actor.key === o.key && !o.approved && settled && !r.released && (
                    <button className="btn authority sm"
                            onClick={() => asOrg(`${o.label} approves round ${r.id}`,
                              (x) => x.approvePayout(r.id))}>
                      Approve
                    </button>
                  )}
                  {o.approved && <Pill tone="violet">approved</Pill>}
                </div>
              ))}
            </div>

            <div style={{ height: 16 }} />

            <div className="row">
              <button className="btn authority" disabled={!settled || r.released || !quorum}
                      onClick={() => asOrg(`${actor.label} releases the payout for round ${r.id}`,
                        (x) => x.releasePayout(r.id))}>
                Release the payout
              </button>
              {settled && !r.released && !quorum && (
                <button className="btn danger"
                        onClick={() => asOrg(`${actor.label} attempts release below quorum`,
                          (x) => x.releasePayout.staticCall(r.id), { expectFailure: true })}>
                  Attempt release below quorum
                </button>
              )}
              {!myOrg && settled && !r.released && (
                <button className="btn danger"
                        onClick={() => asOrg(`${actor.label} attempts to approve without a seat`,
                          (x) => x.approvePayout.staticCall(r.id), { expectFailure: true })}>
                  Attempt to approve as {actor.label}
                </button>
              )}
            </div>

            <div className="note" style={{ marginTop: 14 }}>
              With exactly three approvers and a threshold of two, <b>every valid pair contains an
              organisation other than the operator</b>. That is the whole argument: ChitCo can stall
              a payout but can never compel one, and no key in the system moves the escrow to an
              address a caller chose.
            </div>
          </Card>

          <Card title="Settlement arithmetic" tag="audit trail">
            <div className="grid two">
              <KV rows={[
                ["pot collected", `${fmtEth(r.pot)} ETH`],
                ["winning bid", `${fmtEth(r.winningBid)} ETH`],
                ["discount", `${fmtEth(r.discount)} ETH`],
                ["statutory floor", `${fmtEth(r.minimumBid)} ETH`],
              ]} />
              <KV rows={[
                ["non-winners", String(nonWinners)],
                ["dividend each", `${fmtEth(share)} ETH`],
                ["escrow now", `${fmtEth(r.contractBalance)} ETH`],
                ["released", r.released ? "yes" : "no"],
              ]} />
            </div>
            <div className="note" style={{ marginTop: 14 }}>
              A member carrying arrears has her dividend applied to the debt first and keeps only the
              remainder. That is the whole of the default mechanism: it softens the loss, it does not
              remove it, and the platform says so rather than claiming otherwise.
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Dividend and arrears ledger" flush>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Subscriber</th><th className="num">Dividend</th><th className="num">Arrears</th><th className="num">Missed</th></tr>
                </thead>
                <tbody>
                  {state.members.map((m) => {
                    const a = actors.find((x) => x.address.toLowerCase() === m.addr.toLowerCase());
                    return (
                      <tr key={m.addr} className={m.defaulted ? "dead" : ""}>
                        <td><Who actor={a} address={m.addr} /></td>
                        <td className="num" style={{ color: m.dividends > 0n ? "var(--mint)" : undefined }}>
                          {fmtEth(m.dividends)}
                        </td>
                        <td className="num" style={{ color: m.arrears > 0n ? "var(--warn)" : undefined }}>
                          {fmtEth(m.arrears)}
                        </td>
                        <td className="num">
                          {m.missedPayments}
                          {m.defaulted && " ✕"}
                        </td>
                      </tr>
                    );
                  })}
                  {state.members.length === 0 && (
                    <tr><td colSpan={4}><div className="empty">No subscribers yet.</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Default watch" tag="G2">
            <div className="note">
              A member who does not deposit before bidding opens picks up one missed payment and
              arrears of {fmtEth(c.contribution)} ETH. At <b>{c.defaultThreshold} misses</b> she is
              marked defaulted against her <b>nullifier</b>, not her wallet, so a fresh address does
              not wash the record. A defaulted member cannot bid again.
            </div>
            <div style={{ height: 12 }} />
            <div className="note">
              <b>What this does not do.</b> A member who wins early and stops paying still leaves the
              group short. Collateral large enough to cover that exposure would exclude the
              subscribers this platform exists for, so the design bounds the loss and reports it
              instead of pretending to eliminate it.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
