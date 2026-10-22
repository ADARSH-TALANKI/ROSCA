import React, { useState } from "react";
import { Banner, Pill } from "./ui.jsx";
import { ATTACKS } from "../lab.js";
import { revertReason } from "../chain.js";

const BLANK = { traces: [], verdict: null, summary: null, running: false };

export default function AttackLab({ log }) {
  const [res, setRes] = useState(() =>
    Object.fromEntries(ATTACKS.map((a) => [a.id, { naive: { ...BLANK }, ours: { ...BLANK } }]))
  );
  const [busy, setBusy] = useState(false);

  const patch = (id, side, delta) =>
    setRes((p) => ({ ...p, [id]: { ...p[id], [side]: { ...p[id][side], ...delta } } }));

  const pushTrace = (id, side, line) =>
    setRes((p) => ({
      ...p,
      [id]: { ...p[id], [side]: { ...p[id][side], traces: [...p[id][side].traces, line] } },
    }));

  const collector = (id, side) => {
    const mk = (tone, ic) => (text) => pushTrace(id, side, { tone, ic, text });
    return {
      step: mk("", "→"),
      ok: mk("ok", "✓"),
      bad: mk("bad", "✕"),
      warn: mk("warn", "!"),
      dim: mk("dim", "·"),
    };
  };

  async function runSide(atk, side) {
    patch(atk.id, side, { traces: [], verdict: null, summary: null, running: true });
    try {
      const out = await atk[side](collector(atk.id, side));
      patch(atk.id, side, { ...out, running: false });
      log(
        `${atk.id} ${side === "naive" ? "prior art" : "this work"}: ${out.verdict === "breached" ? "BREACHED" : "BLOCKED"}`,
        out.verdict === "breached" ? "bad" : "ok"
      );
    } catch (e) {
      pushTrace(atk.id, side, { tone: "warn", ic: "!", text: `scenario aborted: ${revertReason(e)}` });
      patch(atk.id, side, { running: false, verdict: "pending", summary: "The scenario could not complete. Check that the Hardhat node is still running." });
      log(`${atk.id} ${side} aborted: ${revertReason(e)}`, "bad");
    }
  }

  async function runOne(atk) {
    setBusy(true);
    log(`attack lab: running ${atk.id} — ${atk.title}`, "warn");
    await runSide(atk, "naive");
    await runSide(atk, "ours");
    setBusy(false);
  }

  async function runAll() {
    setBusy(true);
    for (const a of ATTACKS) {
      log(`attack lab: running ${a.id} — ${a.title}`, "warn");
      await runSide(a, "naive");
      await runSide(a, "ours");
    }
    setBusy(false);
  }

  const done = ATTACKS.filter((a) => res[a.id].ours.verdict).length;
  const blocked = ATTACKS.filter((a) => res[a.id].ours.verdict === "blocked").length;
  const breached = ATTACKS.filter((a) => res[a.id].naive.verdict === "breached").length;

  return (
    <div className="stack">
      <Banner tone="bad" icon="◆">
        <b>Side-by-side adversarial evaluation.</b> Each scenario is executed twice, against two
        contracts deployed fresh for that run: <b>NaiveChitFund</b>, a faithful reconstruction of the
        designs reported in the reviewed literature, and <b>ChitFund</b>, this project's contract.
        Nothing here is simulated and nothing is hard-coded. These are real transactions on the local
        chain, and the reverts are the contract's own.
      </Banner>

      <div className="card">
        <div className="card-head">
          <h3>Run the suite</h3>
          <p>{done} of {ATTACKS.length} scenarios executed · {breached} landed on prior art · {blocked} blocked here</p>
          <div className="spacer" />
          <button className="btn primary" disabled={busy} onClick={runAll}>
            {busy ? "running…" : `Run all ${ATTACKS.length} scenarios`}
          </button>
        </div>
      </div>

      <div className="atk">
        {ATTACKS.map((atk) => {
          const r = res[atk.id];
          return (
            <div className="atk-card" key={atk.id}>
              <div className="atk-head">
                <span className="ax">{atk.id}</span>
                <div style={{ minWidth: 0 }}>
                  <b>{atk.title}</b>
                  <small>{atk.subtitle}</small>
                </div>
                <div className="spacer" />
                <Pill tone="teal">{atk.gap}</Pill>
                <button className="btn sm" disabled={busy} onClick={() => runOne(atk)}>
                  {r.naive.running || r.ours.running ? "running…" : "Run"}
                </button>
              </div>

              <div className="atk-split">
                <Side side="naive" label={atk.naiveLabel} source={atk.source} data={r.naive} />
                <Side side="ours" label={atk.oursLabel} source="this work" data={r.ours} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="note">
        <b>On the reverts.</b> A step that is meant to fail is executed against the deployed
        contract read-only, so it runs the same bytecode against the same state and returns the
        contract's own revert string without leaving a failed transaction behind on the demo chain.
        Every step that is meant to succeed is a mined transaction.
      </div>

      <div className="note">
        Reproducing the same results from the terminal: <code className="plain">npm test</code> runs
        the full suite, including <code className="plain">test/AttackComparison.test.js</code>, which
        asserts each of these outcomes as a passing test rather than a screenshot.
      </div>
    </div>
  );
}

function Side({ side, label, source, data }) {
  const v = data.verdict;
  return (
    <div className={`atk-side ${side}`}>
      <div className="as-head">
        <Pill tone={side === "naive" ? "bad" : "ok"}>{side === "naive" ? "prior art" : "this work"}</Pill>
        <b>{label}</b>
      </div>
      <div className="as-sub">{source}</div>

      {data.traces.length === 0 && !data.running && (
        <div className="empty" style={{ padding: "22px 0" }}>not run yet</div>
      )}
      {data.running && data.traces.length === 0 && (
        <div className="empty" style={{ padding: "22px 0" }}>deploying a fresh instance…</div>
      )}

      <div className="trace">
        {data.traces.map((t, i) => (
          <div className={`trace-row ${t.tone}`} key={i}>
            <span className="ic">{t.ic}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>

      {v && (
        <div className={`verdict ${v}`}>
          <span>{v === "breached" ? "✕" : v === "blocked" ? "✓" : "…"}</span>
          <span>
            {v === "breached" ? "ATTACK SUCCEEDED" : v === "blocked" ? "ATTACK BLOCKED" : "INCOMPLETE"}
            {" — "}
            <span style={{ fontWeight: 400 }}>{data.summary}</span>
          </span>
        </div>
      )}
    </div>
  );
}
