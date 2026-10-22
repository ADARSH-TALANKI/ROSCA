import React, { useMemo, useState } from "react";
import { Card, Banner, Hash, Pill, Field, Avatar, Who } from "./ui.jsx";
import { makeNullifier, PLATFORM_SALT, short, chitAs } from "../chain.js";

export default function IdentityTab({ state, cfg, actor, actors, tx, log }) {
  const members = actors.filter((a) => a.kind === "member");
  const byAddr = useMemo(() => {
    const m = {};
    state.members.forEach((x) => { m[x.addr.toLowerCase()] = x; });
    return m;
  }, [state]);

  const unregistered = members.filter((a) => !byAddr[a.address.toLowerCase()]?.registered);

  const [target, setTarget] = useState(unregistered[0]?.key || members[0].key);
  const targetActor = actors.find((a) => a.key === target) || members[0];
  const [govId, setGovId] = useState(targetActor.govId || "");

  React.useEffect(() => {
    const a = actors.find((x) => x.key === target);
    if (a?.govId) setGovId(a.govId);
  }, [target]);

  const nullifier = govId.trim() ? makeNullifier(govId.trim()) : null;
  const clash = nullifier
    ? state.members.find((m) => m.registered && m.nullifier.toLowerCase() === nullifier.toLowerCase())
    : null;
  const clashActor = clash ? actors.find((a) => a.address.toLowerCase() === clash.addr.toLowerCase()) : null;

  const isRegistrar = actor.key === "registrar";

  // Sybil probe
  const [sybilWallet, setSybilWallet] = useState("attacker");
  const [sybilId, setSybilId] = useState(members[0].govId || "");
  const sybilNullifier = sybilId.trim() ? makeNullifier(sybilId.trim()) : null;
  const sybilWalletActor = actors.find((a) => a.key === sybilWallet);

  const enrol = () =>
    tx(
      `registrar enrols ${targetActor.label}`,
      async () => {
        const c = await chitAs(cfg.actors.find((a) => a.key === "registrar").address);
        return c.registerMember(targetActor.address, nullifier);
      }
    );

  const probeSybil = () =>
    tx(
      `registrar attempts a second seat for ${sybilId.trim()}`,
      async () => {
        const c = await chitAs(cfg.actors.find((a) => a.key === "registrar").address);
        return c.registerMember.staticCall(sybilWalletActor.address, sybilNullifier);
      },
      { expectFailure: true }
    );

  return (
    <div className="stack">
      <Banner tone="info" icon="◆">
        <b>Route B, role separation.</b> The Registrar of Chits checks the document, derives the
        nullifier off-chain, and submits only the 32-byte result. ChitCo runs the auction and never
        sees an identity. No identifier, hashed or otherwise, maps back to a person on the chain.
      </Banner>

      <div className="grid wide-left">
        <Card title="Nullifier derivation" tag="G3"
              sub="Type a document number and watch what actually reaches the contract.">
          <div className="grid two" style={{ gap: 18 }}>
            <div>
              <Field label="Subscriber to enrol">
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  {members.map((m) => {
                    const done = byAddr[m.address.toLowerCase()]?.registered;
                    return (
                      <option key={m.key} value={m.key}>
                        {m.label} {done ? "(already enrolled)" : ""}
                      </option>
                    );
                  })}
                </select>
              </Field>

              <Field label="Government document number (off-chain)">
                <input className="mono" value={govId} onChange={(e) => setGovId(e.target.value)}
                       placeholder="AADHAAR-0000" />
              </Field>

              <Field label="Platform salt (fixed, published)">
                <input className="mono" value={PLATFORM_SALT} readOnly />
              </Field>

              {!isRegistrar && (
                <div className="banner warn" style={{ marginBottom: 12 }}>
                  <span className="bi">!</span>
                  <div>
                    You are acting as <b>{actor.label}</b>. Only the Registrar of Chits can enrol a
                    member. Switch persona above to submit this.
                  </div>
                </div>
              )}

              <button className="btn primary block" disabled={!isRegistrar || !nullifier || !!clash}
                      onClick={enrol}>
                Submit nullifier to the chain
              </button>
              {clash && (
                <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>
                  <span className="bi">✕</span>
                  <div>
                    This document is already enrolled as <b>{clashActor?.label || short(clash.addr)}</b>.
                    The transaction would revert with <code className="plain">nullifier already used</code>.
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="lede">what happens to the number</div>
              <div className="flow">
                <div className="flow-node done">
                  <div className="fh"><span className="fn">1</span><b>Held by the registrar</b></div>
                  <p>
                    <code className="plain">{govId || "—"}</code><br />
                    Stays in the registrar's own records. Never a transaction argument.
                  </p>
                </div>
                <div className="flow-arrow">↓ keccak256(document ‖ salt)</div>
                <div className={`flow-node ${nullifier ? "active" : ""}`}>
                  <div className="fh"><span className="fn">2</span><b>Nullifier, 32 bytes</b></div>
                  <p style={{ wordBreak: "break-all", fontFamily: "var(--mono)", fontSize: 11 }}>
                    {nullifier || "—"}
                  </p>
                  <p style={{ marginTop: 6 }}>
                    Deterministic in the document, one-way, and carries no attributes: not a name,
                    not an age, not an address.
                  </p>
                </div>
                <div className="flow-arrow">↓ registerMember(wallet, nullifier)</div>
                <div className="flow-node">
                  <div className="fh"><span className="fn">3</span><b>On-chain registry</b></div>
                  <p>
                    Stored as <code className="plain">nullifierUsed[n] = true</code>. A second
                    enrolment with the same document recomputes the same 32 bytes and is refused.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Sybil probe" tag="attack"
              sub="Try to buy a second seat for a person who already holds one.">
          <Field label="Wallet to enrol">
            <select value={sybilWallet} onChange={(e) => setSybilWallet(e.target.value)}>
              {actors.filter((a) => a.kind !== "org").map((a) => (
                <option key={a.key} value={a.key}>{a.label} · {short(a.address)}</option>
              ))}
            </select>
          </Field>
          <Field label="Document number presented">
            <input className="mono" value={sybilId} onChange={(e) => setSybilId(e.target.value)} />
          </Field>

          <div className="kv" style={{ marginBottom: 12 }}>
            <div className="kv-row">
              <span className="k">computed nullifier</span>
              <span className="v"><Hash value={sybilNullifier} chars={8} /></span>
            </div>
            <div className="kv-row">
              <span className="k">already in registry</span>
              <span className="v">
                {sybilNullifier &&
                 state.members.some((m) => m.registered && m.nullifier.toLowerCase() === sybilNullifier.toLowerCase())
                  ? <Pill tone="bad">yes</Pill> : <Pill tone="ok">no</Pill>}
              </span>
            </div>
          </div>

          <button className="btn danger block" onClick={probeSybil}
                  disabled={actor.key !== "registrar" || !sybilNullifier}>
            Attempt the second enrolment
          </button>
          <div className="note" style={{ marginTop: 12 }}>
            Act as the <b>Registrar</b> and run this with a document that is already enrolled. The
            revert is the Sybil defence doing its job. The same probe against{" "}
            <b>NaiveChitFund</b> succeeds, which is attack <b>A2</b> in the lab.
          </div>
        </Card>
      </div>

      <Card title="Nullifier registry" tag={`${state.members.filter((m) => m.registered).length} of ${state.config.groupSize}`}
            flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Subscriber</th>
                <th>Document (registrar's records only)</th>
                <th>Nullifier on chain</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((a) => {
                const m = byAddr[a.address.toLowerCase()];
                const reg = m?.registered;
                return (
                  <tr key={a.key} className={actor.key === a.key ? "me" : ""}>
                    <td><Who actor={a} /></td>
                    <td><code className="plain">{a.govId}</code></td>
                    <td>{reg ? <Hash value={m.nullifier} chars={14} /> : <span className="muted tiny">not submitted</span>}</td>
                    <td>
                      {reg
                        ? m.defaulted ? <Pill tone="bad">defaulted</Pill> : <Pill tone="ok">enrolled</Pill>
                        : <Pill tone="gray">pending</Pill>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
