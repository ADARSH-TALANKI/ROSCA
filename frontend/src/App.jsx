import React, { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";

import { cfg, provider, chitRead, readState, revertReason, fmtEth, short } from "./chain.js";
import TopBar from "./components/TopBar.jsx";
import ActorBar from "./components/ActorBar.jsx";
import PhaseStepper from "./components/PhaseStepper.jsx";
import EventLog from "./components/EventLog.jsx";
import Overview from "./components/Overview.jsx";
import IdentityTab from "./components/IdentityTab.jsx";
import RoundTab from "./components/RoundTab.jsx";
import PayoutTab from "./components/PayoutTab.jsx";
import AttackLab from "./components/AttackLab.jsx";
import { Card } from "./components/ui.jsx";

const TABS = [
  { key: "overview", label: "How it works" },
  { key: "identity", label: "Identity" },
  { key: "round", label: "The auction" },
  { key: "payout", label: "Settlement" },
  { key: "lab", label: "Attack lab" },
];

const clock = () =>
  new Date().toLocaleTimeString("en-GB", { hour12: false }).slice(0, 8);

let seq = 0;

export default function App() {
  const [tab, setTab] = useState("overview");
  const [actorKey, setActorKey] = useState("registrar");
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(true);
  const [blockNumber, setBlockNumber] = useState(0);
  const [entries, setEntries] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [fatal, setFatal] = useState(null);

  const scanned = useRef(0);
  const actor = cfg.actors.find((a) => a.key === actorKey) || cfg.actors[0];

  // ------------------------------------------------------------------ logging

  const log = useCallback((text, tone = "") => {
    setEntries((p) => [{ id: ++seq, at: clock(), text, tone }, ...p].slice(0, 400));
  }, []);

  const toast = useCallback((text, tone) => {
    const id = ++seq;
    setToasts((p) => [...p, { id, text, tone }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4200);
  }, []);

  // ---------------------------------------------------------------- refreshing

  const refresh = useCallback(async () => {
    try {
      const s = await readState();
      setState(s);
      setConnected(true);
      return s;
    } catch (e) {
      setConnected(false);
      if (String(e?.message || "").includes("could not decode")) {
        setFatal("stale");
      }
      return null;
    }
  }, []);

  const scanEvents = useCallback(async () => {
    try {
      const bn = await provider.getBlockNumber();
      setBlockNumber(bn);
      if (scanned.current === 0) { scanned.current = bn; return; }
      if (bn <= scanned.current) return;

      const logs = await provider.getLogs({
        address: cfg.chitFund,
        fromBlock: scanned.current + 1,
        toBlock: bn,
      });
      scanned.current = bn;

      for (const l of logs) {
        let parsed;
        try { parsed = chitRead.interface.parseLog(l); } catch { continue; }
        if (parsed) log(describeEvent(parsed), "evt");
      }
    } catch {
      setConnected(false);
    }
  }, [log]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await refresh();
      await scanEvents();
    })();
    const t = setInterval(async () => {
      if (!alive) return;
      await refresh();
      await scanEvents();
    }, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [refresh, scanEvents]);

  // ------------------------------------------------------- transaction helper

  const tx = useCallback(
    async (label, build, { expectFailure = false } = {}) => {
      log(`${label}…`);
      try {
        const sent = await build();
        if (sent?.wait) await sent.wait();
        if (expectFailure) {
          log(`${label} — went through, which the design did not intend`, "warn");
          toast("That call succeeded. Worth a look.", "bad");
        } else {
          log(`${label} — confirmed`, "ok");
          toast(label, "ok");
        }
      } catch (e) {
        const why = revertReason(e);
        if (expectFailure) {
          log(`${label} — rejected by the contract: "${why}"`, "ok");
          toast(`Blocked: ${why}`, "ok");
        } else {
          log(`${label} — reverted: "${why}"`, "bad");
          toast(`Reverted: ${why}`, "bad");
        }
      }
      await refresh();
      await scanEvents();
    },
    [log, toast, refresh, scanEvents]
  );

  // --------------------------------------------------------------- gate states

  if (!state && !connected) {
    return (
      <Gate
        title="Cannot reach the local chain"
        body={
          <>
            Nothing is answering on <code>{cfg.rpcUrl}</code>. In one terminal run{" "}
            <code>npm run node</code> and leave it open, then in a second terminal run{" "}
            <code>npm run dev</code>.
          </>
        }
      />
    );
  }

  if (!state) return <Gate title="Reading the chain" body="Loading contract state…" spin />;

  if (fatal === "stale") {
    return (
      <Gate
        title="Deployed addresses look stale"
        body={
          <>
            The frontend is pointed at <code>{short(cfg.chitFund, 8)}</code> but the node does not
            have that contract, which happens after a node restart. Run <code>npm run deploy</code>{" "}
            and reload.
          </>
        }
      />
    );
  }

  const shared = { state, cfg, actor, actors: cfg.actors, tx, log };

  return (
    <div className="app">
      <TopBar connected={connected} state={state} blockNumber={blockNumber} cfg={cfg} />

      <nav className="tabs">
        {TABS.map((t, i) => (
          <button key={t.key} className={`tab${tab === t.key ? " active" : ""}`}
                  onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="main">
        <div className="stack">
          {tab !== "lab" && (
            <>
              <div className="personas">
                <p className="hint">
                  Every button sends a real transaction signed by the selected account.
                  You are acting as <b style={{ color: "var(--brass)" }}>{actor.label}</b>.
                </p>
                <ActorBar actors={cfg.actors} current={actorKey} onPick={setActorKey} state={state} />
              </div>
              {tab !== "round" && <PhaseStepper state={state} />}
            </>
          )}

          {tab === "lab" ? (
            <AttackLab log={log} />
          ) : (
            <div className="grid sidebar">
              <div className="stack">
                {tab === "overview" && <Overview {...shared} />}
                {tab === "identity" && <IdentityTab {...shared} />}
                {tab === "round" && <RoundTab {...shared} />}
                {tab === "payout" && <PayoutTab {...shared} />}
              </div>
              <EventLog entries={entries} onClear={() => setEntries([])} />
            </div>
          )}

          {tab === "lab" && <EventLog entries={entries} onClear={() => setEntries([])} />}
        </div>
      </main>

      <div className="toast-stack">
        {toasts.map((t) => (
          <div className={`toast ${t.tone || ""}`} key={t.id}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function Gate({ title, body, spin }) {
  return (
    <div className="app">
      <div className="gate">
        {spin && <div className="spinner" />}
        <h2>{title}</h2>
        <div style={{ maxWidth: 520, margin: "0 auto", lineHeight: 1.7 }}>{body}</div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- event prose

const who = (addr) => {
  const a = cfg.actors.find((x) => x.address.toLowerCase() === String(addr).toLowerCase());
  return a ? a.label : short(addr);
};

function describeEvent(p) {
  const a = p.args;
  switch (p.name) {
    case "MemberRegistered":
      return `MemberRegistered · ${who(a[0])} enrolled under nullifier ${String(a[1]).slice(0, 14)}…`;
    case "RoundStarted":
      return `RoundStarted · round ${a[0]} open for deposits`;
    case "Deposited":
      return `Deposited · ${who(a[1])} paid ${fmtEth(a[2])} ETH into round ${a[0]}`;
    case "PaymentMissed":
      return `PaymentMissed · ${who(a[1])} missed round ${a[0]} (${a[2]} total)`;
    case "MemberDefaulted":
      return `MemberDefaulted · ${who(a[0])} marked defaulted against her nullifier`;
    case "BiddingRoundOpened":
      return Number(a[2]) > 0
        ? `BiddingRoundOpened · bidding round ${a[1]} open, beat ${fmtEth(a[2])} ETH`
        : `BiddingRoundOpened · bidding round ${a[1]} open, no standing bid yet`;
    case "BidCommitted":
      return `BidCommitted · ${who(a[2])} sealed a bid in bidding round ${a[1]} (amount not on chain)`;
    case "RevealOpened":
      return `RevealOpened · bidding round ${a[1]} accepting openings`;
    case "BidRevealed":
      return `BidRevealed · ${who(a[2])} opened at ${fmtEth(a[3])} ETH`;
    case "StandingBidUpdated":
      return `StandingBidUpdated · ${fmtEth(a[3])} ETH now stands, held by ${who(a[2])}`;
    case "BiddingRoundClosed":
      return a[2]
        ? `BiddingRoundClosed · bidding round ${a[1]} produced an improvement`
        : `BiddingRoundClosed · bidding round ${a[1]} attracted nothing, settling`;
    case "AuctionClosed":
      return `AuctionClosed · ${who(a[1])} prized at ${fmtEth(a[2])} ETH after ${a[4]} bidding round(s), discount ${fmtEth(a[3])} ETH`;
    case "LotteryFallback":
      return `LotteryFallback · no lawful bid, round ${a[0]} drawn by lot to ${who(a[1])}`;
    case "PayoutApproved":
      return `PayoutApproved · ${who(a[1])} approved round ${a[0]} (${a[2]} of 2)`;
    case "PayoutReleased":
      return `PayoutReleased · ${fmtEth(a[2])} ETH sent to ${who(a[1])}`;
    case "DividendDiverted":
      return `DividendDiverted · ${fmtEth(a[2])} ETH of ${who(a[1])}'s dividend applied to arrears`;
    case "DividendClaimed":
      return `DividendClaimed · ${who(a[0])} withdrew ${fmtEth(a[1])} ETH`;
    default:
      return `${p.name} · ${p.args.map((x) => String(x)).join(", ")}`;
  }
}
