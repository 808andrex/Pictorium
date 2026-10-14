/**
 * Shared AES-256-GCM crypto for per-user secrets at rest (server-only).
 *
 * Single implementation backing `user-keys.ts` (per-namespace API keys) and
 * `trakt-auth.ts` (per-user Trakt OAuth tokens). Extracted verbatim from
 * `user-keys.ts` so both consumers share one code path — no parallel
 * implementations, no silent downgrades.
 *
 * Key: `PROFILE_ENCRYPTION_KEY` (`openssl rand -hex 32`). Deliberately
 * strict: only 64 hex chars (= 32 bytes). Any other shape → null
 * (fail-closed, never weak/silent encryption).
 *
 * No `server-only` package import: the package is not a dependency, and a
 * bare import would fail typecheck/build (same rule as `i18n-server.ts`).
 * The boundary is enforced by the import graph: this module imports
 * `node:crypto` and is reachable only from server lib modules and
 * `src/app/api/**` routes. NEVER import it from client components or from
 * shared client/server leaves (`poster-config`, `poster-url`, ...).
 */
import crypto from "node:crypto"

export interface EncBundle {
  iv: string
  tag: string
  data: string
}

/**
 * AES-256-GCM key from PROFILE_ENCRYPTION_KEY, or null when missing/invalid.
 * Read live (never at module level): tests mutate env + resetModules.
 */
export function profileEncryptionKey(): Buffer | null {
  const raw = process.env.PROFILE_ENCRYPTION_KEY?.trim()
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) return null
  return Buffer.from(raw, "hex")
}

export function isProfileEncryptionAvailable(): boolean {
  return profileEncryptionKey() !== null
}

export function encryptProfileSecret(plaintext: string, key: Buffer): EncBundle {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }
}

export function decryptProfileSecret(bundle: EncBundle, key: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(bundle.iv, "base64"))
  decipher.setAuthTag(Buffer.from(bundle.tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(bundle.data, "base64")), decipher.final()]).toString("utf8")
}

export function isValidEncBundle(v: unknown): v is EncBundle {
  if (!v || typeof v !== "object") return false
  const b = v as Record<string, unknown>
  return typeof b.iv === "string" && typeof b.tag === "string" && typeof b.data === "string"
}
