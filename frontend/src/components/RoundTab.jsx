import React, { useMemo, useState, useEffect } from "react";
import { Card, Banner, Hash, Pill, Field, Who, Stat } from "./ui.jsx";
import {
  chitAs, fmtEth, tryParseEth, short, PHASES, makeCommitment, randomSalt,
  rememberBid, recallBid, isZeroHash, ZERO_ADDR,
} from "../chain.js";

export default function RoundTab({ state, cfg, actor, actors, tx }) {
  const r = state.round;
  const c = state.config;

  const me = useMemo(
    () => state.members.find((m) => m.addr.toLowerCase() === actor.address.toLowerCase()),
    [state, actor]
  );

  const isOperator = actor.key === "chitCo";
  const isMember = !!me?.registered;
  const registered = state.members.filter((m) => m.registered).length;
  const bidding = r.phase === 2 || r.phase === 3;

  const sealedCount = state.members.filter((m) => !isZeroHash(m.commitment)).length;
  const openedCount = state.members.filter((m) => m.revealed).length;

  const [bid, setBid] = useState("");
  const [altered, setAltered] = useState("");

  const saved = isMember && r.id > 0 ? recallBid(r.id, r.biddingRound, actor.address) : null;

  useEffect(() => {
    if (saved && !altered) setAltered(fmtEth(saved.amount));
  }, [saved?.amount, r.id, r.biddingRound]);

  // suggest a sensible opening bid whenever the window moves
  useEffect(() => {
    if (r.phase !== 2) return;
    const suggestion = r.standingBid > 0n
      ? r.standingBid - (r.standingBid - r.minimumBid) / 4n
      : r.pot - (r.pot - r.minimumBid) / 4n;
    setBid(fmtEth(suggestion));
  }, [r.id, r.biddingRound, r.phase]);

  const bidWei = tryParseEth(bid);
  const alteredWei = tryParseEth(altered);
  const tooLow = bidWei !== null && bidWei < r.minimumBid;
  const tooHigh = bidWei !== null && bidWei > r.maximumBid;
  const bidOk = bidWei !== null && !tooLow && !tooHigh;

  // --------------------------------------------------------------- actions

  const op = (label, fn, opts) =>
    tx(label, async () => fn(await chitAs(c.chitCo)), opts);

  const mine = (label, fn, opts) =>
    tx(label, async () => fn(await chitAs(actor.address)), opts);

  const doCommit = () => {
    if (!bidOk) return;
    const salt = randomSalt();
    const commitment = makeCommitment(bidWei, salt, actor.address);
    return mine(
      `${actor.label} seals ${fmtEth(bidWei)} ETH in bidding round ${r.biddingRound}`,
      async (con) => {
        const t = await con.commitBid(commitment);
        rememberBid(r.id, r.biddingRound, actor.address, bidWei, salt);
        return t;
      }
    );
  };

  const doReveal = (override) => {
    const s = recallBid(r.id, r.biddingRound, actor.address);
    if (!s) {
      return tx(`${actor.label} opens a bid`,
        async () => { throw new Error("no salt stored in this browser for that commitment"); },
        { expectFailure: true });
    }
    const amount = override !== undefined ? alteredWei : s.amount;
    if (amount === null) return;
    const cheating = amount !== s.amount;
    return mine(
      `${actor.label} opens at ${fmtEth(amount)} ETH${cheating ? " (altered)" : ""}`,
      (con) => (cheating ? con.revealBid.staticCall(amount, s.salt) : con.revealBid(amount, s.salt)),
      { expectFailure: cheating }
    );
  };

  // what closing the current bidding round will actually do
  const revealedNow = openedCount;
  const closeLabel =
    revealedNow === 0
      ? "Settle on the standing bid"
      : r.biddingRound >= r.maxBiddingRounds
        ? "Close the final round and settle"
        : `Close bidding round ${r.biddingRound}`;

  const canStart = registered >= c.groupSize && (r.id === 0 || r.released);
  const live =
    canStart && r.phase === 0 ? "start"
      : r.phase === 1 ? "bidding"
      : r.phase === 2 ? "reveal"
      : r.phase === 3 ? "close"
      : null;

  const nextStep =
    live === "start"   ? `Start round ${r.id + 1}.`
      : live === "bidding" ? "Everyone has had a chance to pay. Open sealed bidding."
      : live === "reveal"  ? (sealedCount === 0
          ? "Nothing sealed yet. Let subscribers bid before you open the window."
          : `${sealedCount} sealed. Open the window so they can be opened.`)
      : live === "close"   ? `${openedCount} opened. ${closeLabel}.`
      : r.phase === 4 && !r.released ? "Auction settled. Approvals happen on the Settlement tab."
      : r.phase === 4 && r.released ? "Paid out. Start the next round when you are ready."
      : "Nothing for the operator to do right now.";

  const winnerActor = actors.find(
    (a) => a.address.toLowerCase() === r.winner.toLowerCase()
  );

  // ----------------------------------------------------------------- render

  return (
    <div className="stack">
      <Stage
        state={state}
        actors={actors}
        actor={actor}
        sealedCount={sealedCount}
        openedCount={openedCount}
      />

      <div className="grid sidebar">
        <div className="stack">
          <div className="card">
            <div className="stats">
              <Stat k="Pot this month" v={`${fmtEth(r.pot)} ETH`} s={`${r.depositCount} of ${c.groupSize} paid`} tone="brass" />
              <Stat k="Standing bid" v={r.standingBid > 0n ? `${fmtEth(r.standingBid)} ETH` : "none"}
                    s={r.standingBidder !== ZERO_ADDR
                      ? actors.find((a) => a.address.toLowerCase() === r.standingBidder.toLowerCase())?.label || short(r.standingBidder)
                      : "no lawful bid yet"} tone="brass" />
              <Stat k="Floor" v={`${fmtEth(r.minimumBid)} ETH`} s={`${c.maxDiscountBps / 100}% discount cap`} />
              <Stat k="Must beat" v={r.standingBid > 0n ? `${fmtEth(r.standingBid)} ETH` : "—"}
                    s={r.standingBid > 0n ? "strictly lower" : "any lawful bid"} tone="cyan" />
              <Stat k="Winner" v={r.winner === ZERO_ADDR ? "undecided" : (winnerActor?.label || short(r.winner))}
                    s={r.winner === ZERO_ADDR ? "auction open" : `${fmtEth(r.winningBid)} ETH`}
                    tone={r.winner === ZERO_ADDR ? undefined : "brass"} />
            </div>
          </div>

          <Card title="Bidding history" tag={`round ${r.id || "-"}`}
                sub="What the standing bid was after each sealed round. This is the price discovery the single-round design cannot produce.">
            {r.id === 0 ? (
              <div className="empty">No round has started yet.</div>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>Bidding round</th><th>Standing bid</th><th>Held by</th><th>Improvement</th></tr>
                  </thead>
                  <tbody>
                    {state.history.map((h, i) => {
                      const prev = i > 0 ? state.history[i - 1].amount : 0n;
                      const a = actors.find((x) => x.address.toLowerCase() === h.bidder.toLowerCase());
                      const live = h.biddingRound === r.biddingRound && bidding;
                      if (h.amount === 0n && !live) {
                        return (
                          <tr key={i}>
                            <td>{h.biddingRound}</td>
                            <td colSpan={3} className="muted tiny">not reached</td>
                          </tr>
                        );
                      }
                      return (
                        <tr key={i} className={live ? "me" : ""}>
                          <td>{h.biddingRound}{live && <> <Pill tone="cyan">live</Pill></>}</td>
                          <td style={{ color: "var(--brass)", fontWeight: 650 }}>
                            {h.amount > 0n ? `${fmtEth(h.amount)} ETH` : "—"}
                          </td>
                          <td>{h.amount > 0n ? (a?.label || short(h.bidder)) : <span className="muted tiny">—</span>}</td>
                          <td className="muted tiny">
                            {h.amount > 0n && prev > 0n ? `${fmtEth(prev - h.amount)} ETH lower` :
                             h.amount > 0n ? "opening bid" : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Subscriber ledger" flush
                sub="Payment record and standing. Bid state is on the table above.">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Subscriber</th><th>Deposit</th>
                    <th className="num">Missed</th><th className="num">Arrears</th>
                    <th className="num">Dividend</th><th>Standing</th>
                  </tr>
                </thead>
                <tbody>
                  {state.members.map((m) => {
                    const a = actors.find((x) => x.address.toLowerCase() === m.addr.toLowerCase());
                    return (
                      <tr key={m.addr}
                          className={[
                            actor.address.toLowerCase() === m.addr.toLowerCase() ? "me" : "",
                            m.defaulted ? "dead" : "",
                          ].join(" ").trim()}>
                        <td><Who actor={a} address={m.addr} /></td>
                        <td>{m.deposited ? <Pill tone="ok">paid</Pill> : <Pill tone="warn">unpaid</Pill>}</td>
                        <td className="num">{m.missedPayments}</td>
                        <td className="num">{fmtEth(m.arrears)}</td>
                        <td className="num">{fmtEth(m.dividends)}</td>
                        <td>
                          {m.defaulted ? <Pill tone="bad">in default</Pill>
                            : m.hasWon ? <Pill tone="violet">prized</Pill>
                            : <Pill tone="gray">eligible</Pill>}
                        </td>
                      </tr>
                    );
                  })}
                  {state.members.length === 0 && (
                    <tr><td colSpan={6}><div className="empty">No subscribers enrolled yet. Start on the Identity tab.</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------------ right rail */}
        <div className="stack">
          <Card title={`Acting as ${actor.label}`} tag={actor.role}>
            <div className="row" style={{ marginBottom: 12 }}><Who actor={actor} /></div>
            <div className="note">{actor.blurb}</div>
          </Card>

          {isOperator && (
            <Card title="Operator controls" tag="ChitCo">
              {canStart || r.phase > 0 ? (
                <div className="step-hint"><span className="dot" />{nextStep}</div>
              ) : (
                <div className="banner warn" style={{ marginBottom: 12 }}>
                  <span className="bi">!</span>
                  <div>
                    {registered} of {c.groupSize} subscribers enrolled. A chit runs with a fixed
                    group, so the contract will not start a round until the Registrar has admitted
                    all {c.groupSize}.
                  </div>
                </div>
              )}
              <div className="stack" style={{ gap: 10 }}>
                <button className={`btn block${live === "start" ? " primary next-up" : ""}`}
                        disabled={live !== "start"}
                        onClick={() => op(`ChitCo starts round ${r.id + 1}`, (x) => x.startRound())}>
                  Start round {r.id + 1}
                </button>
                <button className={`btn block${live === "bidding" ? " primary next-up" : ""}`}
                        disabled={live !== "bidding"}
                        onClick={() => op("ChitCo opens sealed bidding", (x) => x.openBidding())}>
                  Open sealed bidding
                </button>
                <button className={`btn block${live === "reveal" && sealedCount > 0 ? " primary next-up" : ""}`}
                        disabled={live !== "reveal"}
                        onClick={() => op(`ChitCo opens the opening window for bidding round ${r.biddingRound}`,
                          (x) => x.openReveal())}>
                  Open the opening window
                </button>
                <button className={`btn block${live === "close" && (openedCount > 0 || r.standingBid > 0n) ? " primary next-up" : ""}`}
                        disabled={live !== "close"}
                        onClick={() => op(`ChitCo closes bidding round ${r.biddingRound}`,
                          (x) => x.closeBiddingRound())}>
                  {closeLabel}
                </button>
              </div>
              <div className="note" style={{ marginTop: 13 }}>
                {r.phase === 1
                  ? "Opening the bidding also records a missed deposit against anyone who has not paid, so run it even when someone is short."
                  : r.phase === 3 && revealedNow === 0 && r.standingBid > 0n
                    ? "Nobody improved on the standing bid, so closing now settles the auction instead of opening another round."
                    : `Up to ${r.maxBiddingRounds} sealed rounds. The auction stops as soon as a round produces no improvement.`}
              </div>
            </Card>
          )}

          {isMember && (
            <Card title="Your actions" tag={me.isStanding ? "currently leading" : "subscriber"}>
              <div className="stack" style={{ gap: 13 }}>
                <button className="btn primary block" disabled={r.phase !== 1 || me.deposited}
                        onClick={() => mine(`${actor.label} deposits ${fmtEth(c.contribution)} ETH`,
                          (x) => x.deposit({ value: c.contribution }))}>
                  {me.deposited ? "Deposit paid" : `Pay ${fmtEth(c.contribution)} ETH into the pot`}
                </button>

                {r.phase === 2 && (
                  <div>
                    <Field label={
                      r.standingBid > 0n
                        ? `Your bid, between ${fmtEth(r.minimumBid)} and just under ${fmtEth(r.standingBid)} ETH`
                        : `Your bid, between ${fmtEth(r.minimumBid)} and ${fmtEth(r.pot)} ETH`
                    }>
                      <input className={`bid${bidWei !== null && !bidOk ? " invalid" : ""}`}
                             value={bid} onChange={(e) => setBid(e.target.value)} inputMode="decimal" />
                    </Field>

                    {bidWei !== null && tooHigh && r.standingBid > 0n && (
                      <div className="banner bad" style={{ marginBottom: 12 }}>
                        <span className="bi">✕</span>
                        <div>
                          The standing bid is already <b>{fmtEth(r.standingBid)} ETH</b>. A bid in a later
                          round has to beat it, so this one would be rejected when you opened it.
                        </div>
                      </div>
                    )}
                    {bidWei !== null && tooHigh && r.standingBid === 0n && (
                      <div className="banner bad" style={{ marginBottom: 12 }}>
                        <span className="bi">✕</span>
                        <div>You cannot ask for more than the pot holds.</div>
                      </div>
                    )}
                    {bidWei !== null && tooLow && (
                      <div className="banner bad" style={{ marginBottom: 12 }}>
                        <span className="bi">✕</span>
                        <div>
                          Below the statutory floor of <b>{fmtEth(r.minimumBid)} ETH</b>. The Chit Funds Act
                          caps the discount at {c.maxDiscountBps / 100}%.
                        </div>
                      </div>
                    )}

                    <div className="kv" style={{ marginBottom: 12 }}>
                      <div className="kv-row">
                        <span className="k">goes on chain as</span>
                        <span className="v">
                          <Hash value={bidOk ? makeCommitment(bidWei, 1n, actor.address) : null} chars={8} />
                        </span>
                      </div>
                      <div className="kv-row">
                        <span className="k">dividend you give up if you win</span>
                        <span className="v">{bidOk ? `${fmtEth(r.pot - bidWei)} ETH` : "—"}</span>
                      </div>
                    </div>

                    <button className="btn primary block"
                            disabled={!bidOk || !isZeroHash(me.commitment) || me.hasWon || me.defaulted || !me.deposited}
                            onClick={doCommit}>
                      {!isZeroHash(me.commitment) ? "Bid sealed for this round"
                        : me.hasWon ? "Already prized, cannot bid again"
                        : me.defaulted ? "In default, barred from bidding"
                        : !me.deposited ? "Pay into the pot first"
                        : bidWei === null ? "Enter an amount in ETH"
                        : !bidOk ? "Outside the allowed window"
                        : "Seal this bid"}
                    </button>

                    <div className="note" style={{ marginTop: 11 }}>
                      {me.hasWon ? (
                        <><b>One pot each.</b> {actor.label} was prized earlier in this cycle, so the
                        contract refuses any further bid for the rest of it. That is what stops the
                        auction collapsing into whoever is most desperate winning repeatedly.</>
                      ) : me.defaulted ? (
                        <><b>Barred.</b> {me.missedPayments} missed payments, recorded against the
                        nullifier rather than the wallet, so a fresh address does not clear it.</>
                      ) : !me.deposited ? (
                        <><b>Pay first.</b> You cannot bid for a pot you have not paid into this month.</>
                      ) : (
                        <>A fresh random salt is generated per bid and kept in this browser only. The
                        chain receives the hash and nothing else.</>
                      )}
                    </div>
                  </div>
                )}

                {r.phase === 3 && (
                  <div>
                    {saved ? (
                      <>
                        <div className="kv" style={{ marginBottom: 12 }}>
                          <div className="kv-row"><span className="k">you sealed</span>
                            <span className="v">{fmtEth(saved.amount)} ETH</span></div>
                          <div className="kv-row"><span className="k">salt</span>
                            <span className="v">{String(saved.salt).slice(0, 14)}…</span></div>
                        </div>
                        <button className="btn primary block" disabled={me.revealed} onClick={() => doReveal()}>
                          {me.revealed ? "Opened" : `Open your bid at ${fmtEth(saved.amount)} ETH`}
                        </button>

                        <div style={{ height: 16 }} />
                        <div className="lede">Try to cheat</div>
                        <Field label="Open at a different amount instead">
                          <input className="mono" value={altered} onChange={(e) => setAltered(e.target.value)} />
                        </Field>
                        <button className="btn danger block" disabled={me.revealed || alteredWei === null}
                                onClick={() => doReveal(altered)}>
                          Attempt the altered opening
                        </button>
                        <div className="note" style={{ marginTop: 11 }}>
                          Change the number and submit. The hash no longer matches what you committed,
                          so the chain refuses it. That is the sniping defence in a single transaction.
                        </div>
                      </>
                    ) : (
                      <div className="banner warn" style={{ margin: 0 }}>
                        <span className="bi">!</span>
                        <div>
                          Nothing sealed for bidding round {r.biddingRound} in this browser, so there is
                          nothing to open. Sitting a round out is allowed, and costs you nothing.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {me.dividends > 0n && (
                  <button className="btn authority block"
                          onClick={() => mine(`${actor.label} withdraws ${fmtEth(me.dividends)} ETH dividend`,
                            (x) => x.claimDividend())}>
                    Withdraw {fmtEth(me.dividends)} ETH dividend
                  </button>
                )}
              </div>
            </Card>
          )}

          {!isMember && !isOperator && (
            <Card title="What this account cannot do" tag={actor.kind}>
              <Banner tone="warn" icon="!">
                <b>{actor.label}</b> holds no subscriber seat, so every member-only entry point should
                refuse this address. Try them.
              </Banner>
              <div className="stack" style={{ gap: 9 }}>
                <button className="btn danger block"
                        onClick={() => tx(`${actor.label} attempts a deposit`,
                          async () => (await chitAs(actor.address)).deposit.staticCall({ value: c.contribution }),
                          { expectFailure: true })}>
                  Attempt a deposit
                </button>
                <button className="btn danger block"
                        onClick={() => tx(`${actor.label} attempts to seal a bid`,
                          async () => (await chitAs(actor.address))
                            .commitBid.staticCall(makeCommitment(r.minimumBid, 7n, actor.address)),
                          { expectFailure: true })}>
                  Attempt a sealed bid
                </button>
                <button className="btn danger block"
                        onClick={() => tx(`${actor.label} attempts to start a round`,
                          async () => (await chitAs(actor.address)).startRound.staticCall(),
                          { expectFailure: true })}>
                  Attempt to start a round
                </button>
                <button className="btn danger block"
                        onClick={() => tx(`${actor.label} attempts to close the bidding round`,
                          async () => (await chitAs(actor.address)).closeBiddingRound.staticCall(),
                          { expectFailure: true })}>
                  Attempt to close the bidding
                </button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- stage */

function Stage({ state, actors, actor, sealedCount, openedCount }) {
  const r = state.round;
  const bidding = r.phase === 2 || r.phase === 3;
  const settled = r.phase === 4;

  const headline =
    r.phase === 0 ? (r.id === 0 ? "Waiting for enrolment" : "Between rounds")
      : r.phase === 1 ? "Collecting this month's contributions"
      : r.phase === 2 ? `Sealed bidding, round ${r.biddingRound} of ${r.maxBiddingRounds}`
      : r.phase === 3 ? `Opening the bids of round ${r.biddingRound}`
      : r.released ? "Paid out" : "Auction settled";

  const detail =
    r.phase === 1 ? `${r.depositCount} of ${state.config.groupSize} subscribers have paid`
      : r.phase === 2 ? (sealedCount === 0
          ? "nobody has sealed a bid yet"
          : `${sealedCount} sealed, values not on the chain`)
      : r.phase === 3 ? `${openedCount} of ${sealedCount} opened`
      : r.phase === 4 ? `${fmtEth(r.winningBid)} ETH to the prized subscriber`
      : `${fmtEth(r.pot)} ETH in the pot`;

  return (
    <div className="table-stage">
      <div className="stage-caption">
        <span className="phase">{headline}</span>
        <span className="detail">{detail}</span>
        <span className="spacer" />
        {r.id > 0 && (
          <div className="bidrounds">
            {Array.from({ length: r.maxBiddingRounds }, (_, i) => i + 1).map((n) => {
              const past = state.history[n - 1];
              const done = past && past.amount > 0n;
              const live = bidding && n === r.biddingRound;
              const skipped = !done && !live && (r.phase === 4 || n < r.biddingRound);
              return (
                <div key={n} className={`bidround${done ? " done" : ""}${live ? " live" : ""}${skipped ? " skipped" : ""}`}>
                  Round {n}
                  {done ? <b>{fmtEth(past.amount)}</b> : live ? <b>open</b> : <b>—</b>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="slips">
        {state.members.map((m) => {
          const a = actors.find((x) => x.address.toLowerCase() === m.addr.toLowerCase());
          const sealed = !isZeroHash(m.commitment);
          const isWinner = settled && r.winner.toLowerCase() === m.addr.toLowerCase();

          // once the auction has settled the slip shows the outcome, not the
          // state of a bidding round that never opened
          if (settled) {
            return (
              <div key={m.addr} className={`slip ${isWinner ? "standing" : "empty"}${isWinner ? "" : " out"}`}>
                <div className="slip-face">
                  {isWinner && <span className="slip-badge">prized</span>}
                  <span className="seal">{isWinner ? "₹" : "·"}</span>
                  {isWinner ? (
                    <>
                      <div className="slip-amount">{fmtEth(r.winningBid)}<small>ETH</small></div>
                      <div className="slip-state">takes the pot</div>
                    </>
                  ) : (
                    <div className="slip-state">
                      {m.defaulted ? "in default"
                        : m.hasWon ? "prized earlier"
                        : `dividend ${fmtEth(r.discount / BigInt(Math.max(state.members.length - 1, 1)))} ETH`}
                    </div>
                  )}
                </div>
                <div className="slip-name">
                  {a?.label || short(m.addr)}
                  <span>{actor.address.toLowerCase() === m.addr.toLowerCase() ? "you" : a?.role}</span>
                </div>
              </div>
            );
          }

          const out = m.hasWon || m.defaulted;
          const cls = m.isStanding ? "standing"
            : m.revealed ? "open"
            : sealed ? "sealed"
            : "empty";
          return (
            <div key={m.addr} className={`slip ${cls}${out ? " out" : ""}`}>
              <div className="slip-face">
                {m.isStanding && <span className="slip-badge">leading</span>}
                <span className="seal">{m.revealed ? "₹" : sealed ? "◆" : "·"}</span>

                {m.revealed ? (
                  <div className="slip-amount">{fmtEth(m.revealedAmount)}<small>ETH</small></div>
                ) : sealed ? (
                  <>
                    <div className="slip-hash">{m.commitment.slice(0, 12)}…</div>
                    <div className="slip-state">sealed, value unknown</div>
                  </>
                ) : (
                  <div className="slip-state">
                    {m.isStanding ? "holds the standing bid"
                      : out ? (m.hasWon ? "already prized" : "in default")
                      : r.phase === 0 ? "waiting for the round"
                      : !m.deposited ? "has not paid"
                      : bidding ? "sitting this round out"
                      : "no bid yet"}
                  </div>
                )}
              </div>
              <div className="slip-name">
                {a?.label || short(m.addr)}
                <span>{actor.address.toLowerCase() === m.addr.toLowerCase() ? "you" : a?.role}</span>
              </div>
            </div>
          );
        })}
        {state.members.length === 0 && (
          <div className="empty">Nobody is enrolled yet. The table fills once the Registrar admits subscribers.</div>
        )}
      </div>
    </div>
  );
}
