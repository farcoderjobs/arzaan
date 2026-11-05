/**
 * Licence term and signature maths.
 *
 * Deliberately imports nothing but `node:crypto`: the expiry rules are the one
 * piece of this feature that must be unit-testable without a database, an env
 * file or a running server (importing `@/lib/mongodb` would parse the env schema
 * at import time). `@/lib/license` adds the persistence on top.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** One paid year. */
export const LICENSE_TERM_DAYS = 365;
export const LICENSE_DAY_MS = 24 * 60 * 60 * 1000;

export type LicenseStatus = "active" | "expired" | "tampered";

export type LicenseRecord = {
  installedAt: Date;
  paidUntil: Date;
  signature: string;
};

export type LicenseEvaluation = {
  status: LicenseStatus;
  installedAt: Date;
  paidUntil: Date;
  /** Whole days until expiry; 0 once expired. */
  daysLeft: number;
  blocked: boolean;
};

export function licenseTermMs(): number {
  return LICENSE_TERM_DAYS * LICENSE_DAY_MS;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * LICENSE_DAY_MS);
}

/**
 * The signing key. An explicit `LICENSE_SECRET` wins; otherwise it is derived
 * from `JWT_SECRET` so an existing install needs no new environment variable to
 * pick up expiry enforcement.
 */
export function deriveLicenseSecret(jwtSecret: string): string {
  return createHmac("sha256", "pos-license").update(jwtSecret).digest("hex");
}

/**
 * HMAC over the two dates the licence is made of. A `paidUntil` edited by hand
 * in MongoDB (the obvious way to defeat the gate) no longer matches.
 */
export function signLicense(record: Pick<LicenseRecord, "installedAt" | "paidUntil">, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${record.installedAt.toISOString()}|${record.paidUntil.toISOString()}`)
    .digest("hex");
}

export function verifyLicenseSignature(record: LicenseRecord, secret: string): boolean {
  if (!secret) return false;
  return secretsMatch(signLicense(record, secret), String(record.signature ?? ""));
}

/** Constant-time string comparison for activation passwords and signatures. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function evaluateLicense(
  record: LicenseRecord,
  secret: string,
  now: Date = new Date()
): LicenseEvaluation {
  const remaining = record.paidUntil.getTime() - now.getTime();
  const status: LicenseStatus = !verifyLicenseSignature(record, secret)
    ? "tampered"
    : remaining > 0
      ? "active"
      : "expired";

  return {
    status,
    installedAt: record.installedAt,
    paidUntil: record.paidUntil,
    daysLeft: remaining > 0 ? Math.ceil(remaining / LICENSE_DAY_MS) : 0,
    blocked: status !== "active",
  };
}

/**
 * The next expiry after a successful activation: another full term from
 * `paidUntil` when the customer renews early, or from today when they renew
 * after the licence already lapsed (a lapsed year is not back-dated).
 */
export function nextPaidUntil(current: Date | null, now: Date = new Date()): Date {
  const base = current && current.getTime() > now.getTime() ? current : now;
  return addDays(base, LICENSE_TERM_DAYS);
}
