/** Best-effort clipboard copy (no Clipboard API on insecure contexts). */
export function copyToClipboard(text: string): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (!clipboard) return;
  void clipboard.writeText(text).catch(() => undefined);
}
