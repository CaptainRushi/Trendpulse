import type React from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";

export function SkeletonGrid({ count = 6 }: { count?: number }): React.JSX.Element {
  return (
    <div className="skeleton-grid" role="status" aria-label="Loading topics">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-card" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.JSX.Element;
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <Inbox size={32} aria-hidden="true" />
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?: () => void;
}): React.JSX.Element {
  const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : null;
  const hint = error instanceof Error && "hint" in error ? (error as { hint?: unknown }).hint : null;
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={32} aria-hidden="true" />
      <strong>{code === "SHEETS_NOT_FOUND" || code === "SHEETS_FORBIDDEN" ? "Sheets disconnected" : "Something went wrong"}</strong>
      <span>{error.message}</span>
      {typeof hint === "string" ? <span>{hint}</span> : null}
      {onRetry ? (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" /> Retry
        </button>
      ) : null}
    </div>
  );
}
