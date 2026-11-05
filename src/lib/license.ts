/**
 * Subscription gate for a local (client-server) installation.
 *
 * The POS works for one year from installation. Once that year is used up the
 * app stops serving and asks for the activation password; entering it renews the
 * licence for another year and the app starts working again.
 *
 * Deliberate properties:
 *  - the record lives in the `licenses` collection and is NOT replicated (it
 *    describes this installation, not the business), so it never syncs and is
 *    not part of a seed snapshot;
 *  - `paidUntil` is signed with `LICENSE_SECRET` (or a key derived from
 *    `JWT_SECRET`), so editing the date in mongosh blocks the app as tampering
 *    instead of extending it;
 *  - a database outage is NOT treated as non-payment: reads fail open and the
 *    existing "database is down" handling explains the real problem, because
 *    otherwise a stopped MongoDB would look like an expired licence everywhere.
 */

import { connectDB } from "@/lib/mongodb";
import { License } from "@/models";
import {
  LICENSE_TERM_DAYS,
  addDays,
  deriveLicenseSecret,
  evaluateLicense,
  nextPaidUntil,
  secretsMatch,
  signLicense,
  type LicenseStatus,
} from "@/lib/license-core";

export type { LicenseStatus };

/** Single document per installation. */
const LICENSE_KEY = "install";

/** Re-reading the licence on every request is pointless; a minute is enough. */
const CACHE_TTL_MS = 60_000;

export type LicenseState = {
  /** `unavailable` = the database could not be read (fail-open, see above). */
  status: LicenseStatus | "unavailable";
  installedAt: Date | null;
  paidUntil: Date | null;
  daysLeft: number;
  blocked: boolean;
};

/** Thrown by `assertLicenseActive()`; the callers translate it into a redirect/403. */
export class LicenseBlockedError extends Error {
  readonly state: LicenseState;

  constructor(state: LicenseState) {
    super("LICENSE_EXPIRED");
    this.name = "LicenseBlockedError";
    this.state = state;
  }
}

const globals = globalThis as typeof globalThis & {
  __posLicenseCache?: { checkedAt: number; state: LicenseState };
};

function licenseSecret(): string {
  const explicit = (process.env.LICENSE_SECRET ?? "").trim();
  if (explicit.length >= 16) return explicit;
  const jwt = (process.env.JWT_SECRET ?? "").trim();
  return jwt ? deriveLicenseSecret(jwt) : "";
}

function toState(evaluation: ReturnType<typeof evaluateLicense>): LicenseState {
  return { ...evaluation, status: evaluation.status };
}

/**
 * Creates the install record on first use: the free year starts the first time
 * the app asks about its licence, which is the first boot after deployment.
 */
async function ensureLicenseRecord() {
  const existing = await License.findOne({ key: LICENSE_KEY }).lean();
  if (existing) return existing;

  const secret = licenseSecret();
  const installedAt = new Date();
  const paidUntil = addDays(installedAt, LICENSE_TERM_DAYS);
  const signature = signLicense({ installedAt, paidUntil }, secret);

  try {
    const created = await License.findOneAndUpdate(
      { key: LICENSE_KEY },
      { $setOnInsert: { installedAt, paidUntil, signature, activations: [] } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).lean();
    if (created) return created;
  } catch (err) {
    // Two requests racing on the very first boot: one of them wins the insert.
    if ((err as { code?: number }).code !== 11000) throw err;
  }

  const reread = await License.findOne({ key: LICENSE_KEY }).lean();
  if (!reread) throw new Error("Could not create the licence record");
  return reread;
}

async function readLicenseState(): Promise<LicenseState> {
  try {
    await connectDB();
    const record = await ensureLicenseRecord();
    const evaluation = evaluateLicense(
      {
        installedAt: new Date(record.installedAt),
        paidUntil: new Date(record.paidUntil),
        signature: String(record.signature ?? ""),
      },
      licenseSecret()
    );
    return toState(evaluation);
  } catch (err) {
    console.error("[license] could not read the licence record; allowing the request", err);
    return { status: "unavailable", installedAt: null, paidUntil: null, daysLeft: 0, blocked: false };
  }
}

export async function getLicenseState(options: { force?: boolean } = {}): Promise<LicenseState> {
  const cached = globals.__posLicenseCache;
  if (!options.force && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.state;
  }

  const state = await readLicenseState();
  globals.__posLicenseCache = { checkedAt: Date.now(), state };
  return state;
}

/** Throws `LicenseBlockedError` when the licence has lapsed or was tampered with. */
export async function assertLicenseActive(): Promise<void> {
  const state = await getLicenseState();
  if (state.blocked) throw new LicenseBlockedError(state);
}

export function isLicenseBlocked(error: unknown): error is LicenseBlockedError {
  return error instanceof LicenseBlockedError;
}

export type ActivationResult =
  | { ok: true; state: LicenseState }
  | { ok: false; error: string };

/**
 * Validates the activation password and starts a new year.
 *
 * The password is `LICENSE_PASSWORD` on the server; it is never compared in a
 * way that leaks its length. A missing `LICENSE_PASSWORD` is a configuration
 * error and says so instead of silently failing every attempt.
 */
export async function activateLicense(password: string): Promise<ActivationResult> {
  const expected = (process.env.LICENSE_PASSWORD ?? "").trim();
  const supplied = (password ?? "").trim();

  if (!expected) {
    return {
      ok: false,
      error: "Activation is not configured on this server. Set LICENSE_PASSWORD in the server .env file.",
    };
  }
  if (!secretsMatch(supplied, expected)) {
    return { ok: false, error: "That activation password is not valid." };
  }

  try {
    await connectDB();
    const record = await ensureLicenseRecord();
    const now = new Date();
    const installedAt = new Date(record.installedAt);
    const storedPaidUntil = new Date(record.paidUntil);

    // Only a correctly signed, still-running licence is extended from its own
    // end date (renewing early must not cost the customer days). A lapsed or
    // tampered one restarts from today, so an expiry date edited in the database
    // cannot be "activated" into a decade-long term.
    const stillValid =
      evaluateLicense(
        { installedAt, paidUntil: storedPaidUntil, signature: String(record.signature ?? "") },
        licenseSecret()
      ).status === "active";
    const paidUntil = nextPaidUntil(stillValid ? storedPaidUntil : null, now);
    const signature = signLicense({ installedAt, paidUntil }, licenseSecret());

    await License.updateOne(
      { key: LICENSE_KEY },
      {
        $set: { paidUntil, signature },
        $push: { activations: { at: now, until: paidUntil, note: "" } },
      }
    );
  } catch (err) {
    console.error("[license] activation failed", err);
    return { ok: false, error: "The licence could not be saved. Check the database and try again." };
  }

  globals.__posLicenseCache = undefined;
  return { ok: true, state: await getLicenseState({ force: true }) };
}
