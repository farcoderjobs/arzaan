"use server";

import { activateLicense } from "@/lib/license";

export type ActivationActionResult = { error?: string; ok?: boolean };

/**
 * Renews this installation's licence. The password is checked server-side
 * against `LICENSE_PASSWORD`; nothing about the expected value reaches the
 * browser.
 */
export async function activateLicenseAction(password: string): Promise<ActivationActionResult> {
  if (!password || !password.trim()) return { error: "Enter the activation password." };

  const result = await activateLicense(password);
  if (!result.ok) return { error: result.error };

  return { ok: true };
}
