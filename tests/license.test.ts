import { describe, expect, it } from "vitest";
import {
  addDays,
  deriveLicenseSecret,
  evaluateLicense,
  nextPaidUntil,
  secretsMatch,
  signLicense,
  verifyLicenseSignature,
} from "@/lib/license-core";

const SECRET = "test-license-secret-0123456789";
const INSTALLED = new Date("2026-01-01T00:00:00.000Z");

function signed(paidUntil: Date) {
  return {
    installedAt: INSTALLED,
    paidUntil,
    signature: signLicense({ installedAt: INSTALLED, paidUntil }, SECRET),
  };
}

describe("licence term", () => {
  it("is active for a full year after installation", () => {
    const record = signed(addDays(INSTALLED, 365));
    const state = evaluateLicense(record, SECRET, new Date("2026-12-31T23:59:59.000Z"));

    expect(state.status).toBe("active");
    expect(state.blocked).toBe(false);
    expect(state.daysLeft).toBe(1);
  });

  it("blocks the app one second after the year is over", () => {
    const record = signed(addDays(INSTALLED, 365));
    const state = evaluateLicense(record, SECRET, new Date("2027-01-01T00:00:01.000Z"));

    expect(state.status).toBe("expired");
    expect(state.blocked).toBe(true);
    expect(state.daysLeft).toBe(0);
  });

  it("treats a hand-edited expiry date as tampering", () => {
    const record = signed(addDays(INSTALLED, 365));
    const tampered = { ...record, paidUntil: new Date("2099-01-01T00:00:00.000Z") };

    const state = evaluateLicense(tampered, SECRET, new Date("2026-06-01T00:00:00.000Z"));
    expect(state.status).toBe("tampered");
    expect(state.blocked).toBe(true);
  });

  it("rejects a signature produced with a different secret", () => {
    const record = signed(addDays(INSTALLED, 365));
    expect(verifyLicenseSignature(record, "another-secret-0123456789")).toBe(false);
    expect(evaluateLicense(record, "another-secret-0123456789").status).toBe("tampered");
  });

  it("accepts the signature it produced", () => {
    const record = signed(addDays(INSTALLED, 365));
    expect(verifyLicenseSignature(record, SECRET)).toBe(true);
  });
});

describe("renewal", () => {
  it("extends by another year from the current expiry when renewed early", () => {
    const current = new Date("2027-01-01T00:00:00.000Z");
    const now = new Date("2026-12-01T00:00:00.000Z");
    expect(nextPaidUntil(current, now).toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("starts a fresh year from today when renewed after lapsing", () => {
    const current = new Date("2027-01-01T00:00:00.000Z");
    const now = new Date("2027-06-01T00:00:00.000Z");
    expect(nextPaidUntil(current, now).toISOString()).toBe("2028-05-31T00:00:00.000Z");
  });

  it("a renewed licence is active again immediately", () => {
    const now = new Date("2027-06-01T00:00:00.000Z");
    const record = signed(nextPaidUntil(new Date("2027-01-01T00:00:00.000Z"), now));
    expect(evaluateLicense(record, SECRET, now).blocked).toBe(false);
  });
});

describe("activation password comparison", () => {
  it("matches only the exact password", () => {
    expect(secretsMatch("renew-2026", "renew-2026")).toBe(true);
    expect(secretsMatch("renew-2026", "renew-2027")).toBe(false);
    expect(secretsMatch("renew-2026", "renew-202")).toBe(false);
  });
});

describe("signing key", () => {
  it("derives a stable key from the JWT secret", () => {
    expect(deriveLicenseSecret("jwt-secret-value")).toBe(deriveLicenseSecret("jwt-secret-value"));
    expect(deriveLicenseSecret("jwt-secret-value")).not.toBe(deriveLicenseSecret("other-secret"));
  });
});
