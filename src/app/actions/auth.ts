"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { loginSchema } from "@/validations/auth";
import {
  login as authLogin,
  logout as authLogout,
  setAuthCookies,
  clearAuthCookies,
  refreshSession,
  initiatePasswordReset,
  resetPassword as resetPasswordFn,
  changePassword as changePasswordFn,
} from "@/lib/auth";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized, notFound } from "@/lib/api";

export async function login(input: { email: string; password: string }) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Invalid credentials" };
  }

  try {
    const result = await authLogin(parsed.data.email, parsed.data.password);
    await setAuthCookies(result.accessToken, result.refreshToken);
    return { user: result.user };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid credentials";
    return { error: message };
  }
}

export async function logoutAction() {
  await authLogout();
  redirect("/login");
}

export async function refreshAction() {
  const result = await refreshSession();
  if (!result) {
    await clearAuthCookies();
    return { error: "Session expired" };
  }
  await setAuthCookies(result.accessToken, result.refreshToken);
  return { user: result.user };
}

export async function getCurrentUserAction() {
  const user = await getCurrentUser();
  if (!user) {
    return { user: null };
  }
  return { user };
}

export async function requestPasswordReset(body: { email: string }) {
  const result = await initiatePasswordReset(body.email);
  if (!result) {
    return { error: "If that email exists, a reset link has been sent." };
  }
  return { success: true };
}

export async function resetPassword(body: { token: string; newPassword: string; confirmPassword: string }) {
  // basic match check
  if (body.newPassword !== body.confirmPassword) {
    return { error: "Passwords do not match" };
  }
  const ok = await resetPasswordFn(body.token, body.newPassword);
  if (!ok) {
    return { error: "Invalid or expired reset token" };
  }
  return { success: true };
}

export async function changePassword(body: { currentPassword: string; newPassword: string; confirmPassword: string }) {
  if (body.newPassword !== body.confirmPassword) {
    return { error: "Passwords do not match" };
  }
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Not authenticated" };
  }
  const ok = await changePasswordFn(user.id, body.currentPassword, body.newPassword);
  if (!ok) {
    return { error: "Current password is incorrect" };
  }
  return { success: true };
}

export async function requireAuthAction() {
  const user = await getCurrentUser();
  if (!user) {
    await clearAuthCookies();
    redirect("/login");
  }
  return { user: user! };
}
