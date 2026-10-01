import type React from "react";
import { ExternalLink } from "lucide-react";
import type { Digest } from "../lib/api";
import { useSheetLink } from "../hooks/useApi";

export function DigestCard({ digest }: { digest: Digest }): React.JSX.Element {
  const link = useSheetLink();
  return (
    <section className="card" aria-label="Daily digest">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>Daily digest</strong>
        <span style={{ flex: 1 }} />
        {link.data ? (
          <a href={link.data.spreadsheet_url} target="_blank" rel="noopener noreferrer">
            Open sheet <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <p>{digest.digest}</p>
      <span className="badge">
        {digest.topics_count} topics · {digest.items_count} items · {digest.sources_ok}/{digest.sources_total} sources
      </span>
    </section>
  );
}
