/**
 * Decode primitives (docs/11 §4.2). Thin wrappers over the classes in
 * styles/app.css — markup stays readable, styling stays in one file.
 */
import type React from "react";
import { useEffect } from "react";

export function Eyebrow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="eyebrow">{children}</p>;
}

export function Hero({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="hero">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1>{title}</h1>
      {lede ? <p>{lede}</p> : null}
    </div>
  );
}

/** Inline lime highlight for the hero's key words. */
export function Hl({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="hl">{children}</span>;
}

export function BlockGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="block-grid">{children}</div>;
}

export function Block({
  value,
  label,
  variant,
}: {
  value: React.ReactNode;
  label: string;
  variant?: "dark" | "lime";
}): React.JSX.Element {
  return (
    <div className="block" {...(variant ? { "data-variant": variant } : {})}>
      <div className="block-num num">{value}</div>
      <div className="block-label">{label}</div>
    </div>
  );
}

export interface FlowStage {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  jev?: boolean;
}

export function FlowStrip({ stages }: { stages: FlowStage[] }): React.JSX.Element {
  return (
    <ol className="flow-strip" aria-label="Run stages">
      {stages.map((stage, index) => (
        <li
          key={stage.key}
          data-status={stage.status}
          {...(stage.jev ? { "data-jev": "true" } : {})}
          {...(stage.status === "running" ? { "aria-current": "step" as const } : {})}
        >
          <span className="flow-n" aria-hidden="true">
            {index + 1}
          </span>
          {stage.label}
        </li>
      ))}
    </ol>
  );
}

export function Pill({
  tone,
  children,
  label,
}: {
  tone?: "good" | "warn" | "bad" | "info" | "lime" | undefined;
  children: React.ReactNode;
  label?: string;
}): React.JSX.Element {
  return (
    <span className="pill" {...(tone ? { "data-tone": tone } : {})} {...(label ? { "aria-label": label } : {})}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Tip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="tip">{children}</div>;
}

export function CodePanel({
  title,
  onCopy,
  children,
}: {
  title: string;
  onCopy?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="code-panel">
      <div className="code-head">
        <span>{title}</span>
        {onCopy ? (
          <button type="button" className="btn btn-ghost" onClick={onCopy}>
            copy
          </button>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Panel({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="panel" {...(label ? { "aria-label": label } : {})}>
      {children}
    </section>
  );
}

export function EmptyNudge({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="nudge">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}

export function SidePanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <>
      <div
        className="side-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside className="side-panel" role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close panel">
          ← close
        </button>
        {children}
      </aside>
    </>
  );
}

export function Steps({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <ol className="steps">{children}</ol>;
}

export function Step({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li>
      <span className="step-n" aria-hidden="true">
        {String(index).padStart(2, "0")}
      </span>
      <div className="step-body">
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </li>
  );
}
