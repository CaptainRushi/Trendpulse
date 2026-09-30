/**
 * Service-account key loading. The key file lives outside the repo
 * (GOOGLE_SERVICE_ACCOUNT_JSON_PATH, gitignored); this module reads and
 * validates it with actionable errors — the wizard surfaces these verbatim.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const ServiceAccountKey = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
});

export interface ServiceAccountKeyInfo {
  clientEmail: string;
  privateKey: string;
  projectId?: string | undefined;
}

export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Read + validate the service-account JSON. Throws a fix-oriented Error. */
export function loadServiceAccountKeyFile(keyPath: string): ServiceAccountKeyInfo {
  let raw: string;
  try {
    raw = readFileSync(keyPath, "utf8");
  } catch {
    throw new Error(
      `Google service-account key not found at '${keyPath}'. ` +
        `Create one in Google Cloud Console (IAM → Service Accounts → Keys → JSON), ` +
        `save it there, and share your sheet with the service-account email as Editor.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `Google service-account key at '${keyPath}' is not valid JSON. Re-download the key file.`,
    );
  }
  const result = ServiceAccountKey.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Google service-account key at '${keyPath}' is not a service-account JSON ` +
        `(missing client_email/private_key). Download the *service account* key, not an OAuth client.`,
    );
  }
  return {
    clientEmail: result.data.client_email,
    privateKey: result.data.private_key,
    projectId: result.data.project_id,
  };
}
