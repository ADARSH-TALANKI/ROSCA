import React from "react";
import { short } from "../chain.js";

export function Card({ title, tag, sub, right, children, flush, tight }) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h3>{title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          <div className="spacer" />
          {tag && <span className="tag">{tag}</span>}
          {right}
        </div>
      )}
      <div className={`card-body${flush ? " flush" : ""}${tight ? " tight" : ""}`}>{children}</div>
    </div>
  );
}

export function Pill({ tone = "gray", children }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Avatar({ actor, size = 26 }) {
  const kind = actor?.kind === "org" ? "org" : actor?.kind === "outsider" ? "outsider" : "member";
  return (
    <span
      className={`avatar ${kind}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {actor?.short || "?"}
    </span>
  );
}

export function Who({ actor, address }) {
  return (
    <div className="who">
      <Avatar actor={actor} />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{actor?.label || "Unknown"}</div>
        <div className="ad">{short(address || actor?.address)}</div>
      </div>
    </div>
  );
}

export function Hash({ value, dim, chars = 10 }) {
  if (!value || /^0x0{64}$/.test(value)) return <code className="hash dim">not set</code>;
  return (
    <code className={`hash${dim ? " dim" : ""}`} title={value}>
      {value.slice(0, 2 + chars)}…{value.slice(-4)}
    </code>
  );
}

export function Stat({ k, v, s, tone }) {
  return (
    <div className={`stat${tone ? " " + tone : ""}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

export function Banner({ tone = "info", icon, children }) {
  return (
    <div className={`banner ${tone}`}>
      {icon && <span className="bi">{icon}</span>}
      <div>{children}</div>
    </div>
  );
}

export function KV({ rows }) {
  return (
    <div className="kv">
      {rows.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
