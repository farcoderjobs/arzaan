import { z } from "zod";
import { config as loadDotenv } from "dotenv";

// Load .env when running outside Next.js (Next.js loads it itself).
if (!process.env.NEXT_RUNTIME && !process.env.MONGODB_URI) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loadDotenv({ quiet: true });
  } catch {
    // dotenv unavailable (e.g. bundled); Next.js provides env vars instead.
  }
}

const optionalBool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));

const optionalPositiveInt = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  });

/**
 * `MONGODB_URI` is ALWAYS the database this process owns:
 *  - role "shop"   (default) → the local MongoDB on the shop PC (localhost:27017)
 *  - role "center" → the central/online MongoDB
 *
 * A shop reads and writes its local database for every operation; a background
 * sync worker then pushes those changes to the center over HTTP using
 * `SYNC_ONLINE_URL` + the node credentials below. See docs/OFFLINE.md.
 */
export const envSchema = z.object({
  MONGODB_URI: z.string().url().startsWith("mongodb://").or(z.string().url().startsWith("mongodb+srv://")),
  MONGODB_DB_NAME: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().min(1),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1),
  APP_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),

  // ---------- Offline-first node configuration (all optional) ----------
  /**
   * The shop PC's own MongoDB (`mongodb://127.0.0.1:27017`, the instance
   * MongoDB Compass opens). When set and reachable it becomes the database the
   * app uses, so POS pages and sales keep working with no internet. If it is
   * not running the app falls back to `MONGODB_URI` and pauses replication.
   */
  MONGODB_LOCAL_URI: z
    .string()
    .url()
    .startsWith("mongodb://")
    .or(z.string().url().startsWith("mongodb+srv://"))
    .optional(),
  /** "shop" (local DB + sync worker) or "center" (aggregating online DB). */
  NODE_ROLE: z.enum(["shop", "center"]).optional(),
  /** Set to false to disable the sync worker entirely (e.g. report-only instances). */
  SYNC_ENABLED: optionalBool,
  /** Base URL of the center app (e.g. https://pos.example.com). Required to push. */
  SYNC_ONLINE_URL: z.string().url().optional(),
  /** Stable identity of this shop node; registered on the center. */
  SYNC_NODE_ID: z.string().min(3).max(64).optional(),
  /** Human label/stock-location code shown in the center's node list. */
  SYNC_NODE_NAME: z.string().max(120).optional(),
  /** Shared secret of this node (store it only on the shop PC). */
  SYNC_NODE_KEY: z.string().min(16).max(256).optional(),
  /** Push sweep interval in ms (default 60000). */
  SYNC_INTERVAL_MS: optionalPositiveInt,
  /** Pull reference-data deltas from the center (default true when configured). */
  SYNC_PULL_ENABLED: optionalBool,
  /** Max outbox rows per push batch (default 200). */
  SYNC_BATCH_SIZE: optionalPositiveInt,

  // ---------- Licence / subscription (required for an installed build) ----------
  /**
   * Password the customer is given to renew an expired installation. Without
   * it the app still runs for its paid year, but activation is refused with a
   * configuration message instead of failing silently.
   */
  LICENSE_PASSWORD: z.string().optional(),
  /**
   * Signs the licence record (so a hand-edited expiry date is detected). When
   * unset, a key is derived from `JWT_SECRET`; rotating JWT_SECRET therefore
   * requires re-activation, which the password always allows.
   */
  LICENSE_SECRET: z.string().min(16).optional(),
});

export type Env = z.infer<typeof envSchema>;
