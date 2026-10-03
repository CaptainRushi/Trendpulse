/**
 * SSRF gate for the *native fallback* path only (sidecar down).
 * Scheme + literal-host denylist + one DNS resolution per fetch, every
 * address checked against a blocklist.
 *
 * ponytail: redirect re-checking and the full matrix (metadata names,
 * per-redirect DNS) live in the sidecar — this is the degraded path, not
 * the primary one. Prefer the sidecar whenever it is up.
 */
import { BlockList } from "node:net";
import { lookup } from "node:dns/promises";

const block = new BlockList();
for (const subnet of [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", // RFC 1918
  "127.0.0.0/8", "::1/128", // loopback (+ mapped, checked below)
  "169.254.0.0/16", // link-local (cloud metadata)
  "100.64.0.0/10", // shared space (Alibaba metadata lives here)
  "0.0.0.0/8", "192.0.0.0/24", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24",
  "fc00::/7", "fe80::/10", // unique-local + link-local v6
]) {
  const [net, prefix] = subnet.split("/") as [string, string];
  const family = net.includes(":") ? "ipv6" : "ipv4";
  block.addSubnet(net, Number(prefix), family);
}
block.addAddress("100.100.100.200"); // Alibaba metadata, outside 100.64/10

function familyOf(address: string): "ipv4" | "ipv6" {
  return address.includes(":") ? "ipv6" : "ipv4";
}

function allowlist(): Set<string> {
  // TEST ONLY (local fixture servers): exact-IP holes in the gate.
  // Never set in production. Read per call so tests can scope it.
  return new Set(
    (process.env["SCRAPLING_ALLOW_IPS"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
  );
}

/** Throws when the URL must not be fetched natively. Returns the parsed URL. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a URL: ${rawUrl.slice(0, 80)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http/https (got ${url.protocol})`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`SSRF: ${host} is not public`);
  }
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error(`SSRF: ${host} does not resolve`);
  }
  const allowed = allowlist();
  const candidates = records.map((record) => {
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) must be judged as IPv4.
    return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(record.address)?.[1] ?? record.address;
  });
  // Test allowlist passes only when EVERY resolved address is listed —
  // a mix of allowlisted + private stays blocked. Empty in production.
  if (allowed.size > 0 && candidates.every((c) => allowed.has(c))) return url;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as string;
    if (block.check(candidate, familyOf(candidate))) {
      throw new Error(`SSRF: ${host} resolves to a non-public address`);
    }
  }
  return url;
}
