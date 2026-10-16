import { cookies } from "next/headers";
import { User } from "@/models";
import { connectDB } from "@/lib/mongodb";
import {
  verifyAccessToken,
  verifyRefreshToken,
  createAccessToken,
  createRefreshToken,
  hashToken,
  verifyTokenHash,
  generateRandomToken,
  hashPassword,
  verifyPassword,
} from "@/utils/auth";
import { envSchema } from "@/config/env";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  branchId: string | null;
  status: "active" | "inactive" | "pending";
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

function getEnv() {
  return envSchema.parse(process.env);
}

export async function setAuthCookies(accessToken: string, refreshToken: string) {
  const cookieStore = await cookies();
  const env = getEnv();

  cookieStore.set("pos_access_token", accessToken, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https"),
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });

  cookieStore.set("pos_refresh_token", refreshToken, {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https"),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function clearAuthCookies() {
  const cookieStore = await cookies();
  cookieStore.delete("pos_access_token");
  cookieStore.delete("pos_refresh_token");
}

export async function getAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("pos_access_token")?.value ?? null;
  if (!token) return null;

  const payload = verifyAccessToken(token);
  if (!payload || typeof payload === "string") return null;
  if (!payload.sub) return null;

  return token;
}

export async function getRefreshToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("pos_refresh_token")?.value ?? null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  await connectDB();
  const token = await getAccessToken();
  if (!token) return null;

  const payload = verifyAccessToken(token);
  if (!payload || typeof payload !== "object" || !payload.sub) return null;

  const env = getEnv();
  const user = await User.findOne({ _id: payload.sub, status: "active" })
    .select("+passwordHash")
    .lean();

  if (!user) return null;
  const u = user as unknown as Record<string, unknown>;
  const { passwordHash, _id, ...safe } = u;
  return {
    id: String(_id),
    email: u.email as string,
    name: u.name as string,
    roleId: u.roleId ? String(u.roleId) : "",
    branchId: u.branchId ? String(u.branchId) : null,
    status: u.status as "active" | "inactive" | "pending",
    lastLoginAt: u.lastLoginAt ? (u.lastLoginAt as Date).toISOString() : null,
    createdAt: (u.createdAt as Date).toISOString(),
    updatedAt: (u.updatedAt as Date).toISOString(),
  };
}

export async function requireAuth(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHORIZED");
  }
  return user;
}

export async function refreshSession(): Promise<AuthResult | null> {
  await connectDB();
  const refreshTokenStr = await getRefreshToken();
  if (!refreshTokenStr) return null;

  const payload = verifyRefreshToken(refreshTokenStr);
  if (!payload || typeof payload !== "object" || !payload.sub) return null;

  const env = getEnv();
  const user = await User.findOne({ _id: payload.sub, status: "active" }).select("+passwordHash").lean();
  if (!user) return null;

  const existingHash = (user as unknown as Record<string, unknown>).refreshTokenHash as string | undefined;
  const tokenValid = existingHash ? verifyTokenHash(refreshTokenStr, existingHash) : false;
  if (!tokenValid) return null;

  const newAccessToken = createAccessToken(String(user._id), String(user.roleId));
  const newRefreshToken = createRefreshToken(String(user._id));
  const newRefreshHash = hashToken(newRefreshToken);

  await User.findByIdAndUpdate(user._id, {
    refreshTokenHash: newRefreshHash,
    lastLoginAt: new Date(),
  });

  return {
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      roleId: user.roleId ? String(user.roleId) : "",
      branchId: user.branchId ? String(user.branchId) : null,
      status: user.status as "active" | "inactive" | "pending",
      lastLoginAt: ((user.lastLoginAt as Date | null) ?? null) ? (user.lastLoginAt as Date).toISOString() : null,
      createdAt: (user.createdAt as Date).toISOString(),
      updatedAt: (user.updatedAt as Date).toISOString(),
    },
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  await connectDB();
  const env = getEnv();
  const user = await User.findOne({ email: email.toLowerCase(), status: "active" }).select("+passwordHash").lean();
  if (!user) {
    throw new Error("Invalid credentials");
  }
  if (!(user as unknown as Record<string, unknown>).passwordHash) {
    throw new Error("Invalid credentials");
  }
  if (!verifyPassword(password, (user as unknown as Record<string, unknown>).passwordHash as string)) {
    throw new Error("Invalid credentials");
  }

  const accessToken = createAccessToken(String(user._id), String(user.roleId));
  const refreshToken = createRefreshToken(String(user._id));
  const refreshHash = hashToken(refreshToken);

  await User.findByIdAndUpdate(user._id, {
    refreshTokenHash: refreshHash,
    lastLoginAt: new Date(),
  });

  return {
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      roleId: user.roleId ? String(user.roleId) : "",
      branchId: user.branchId ? String(user.branchId) : null,
      status: user.status as "active" | "inactive" | "pending",
      lastLoginAt: ((user.lastLoginAt as Date | null) ?? null) ? (user.lastLoginAt as Date).toISOString() : null,
      createdAt: (user.createdAt as Date).toISOString(),
      updatedAt: (user.updatedAt as Date).toISOString(),
    },
    accessToken,
    refreshToken,
  };
}

export async function logout() {
  await connectDB();
  const refreshTokenStr = await getRefreshToken();
  if (refreshTokenStr) {
    const payload = verifyRefreshToken(refreshTokenStr);
    if (payload && typeof payload === "object" && payload.sub) {
      await User.findByIdAndUpdate(payload.sub, { refreshTokenHash: null });
    }
  }
  await clearAuthCookies();
}

export async function initiatePasswordReset(email: string): Promise<string | null> {
  await connectDB();
  const user = await User.findOne({ email: email.toLowerCase() }).select("+passwordHash").lean();
  if (!user) return null;

  const token = generateRandomToken();
  const hash = hashToken(token);

  await User.findByIdAndUpdate(user._id, {
    passwordResetTokenHash: hash,
    passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
  });

  return token;
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  await connectDB();
  const user = await User.findOne({ passwordResetTokenHash: { $ne: null }, passwordResetExpires: { $gt: new Date() } }).select("+passwordHash").lean();
  if (!user) return false;

  const valid = verifyTokenHash(token, (user as unknown as Record<string, unknown>).passwordResetTokenHash as string);
  if (!valid) return false;

  const hash = hashPassword(newPassword);
  await User.findByIdAndUpdate(user._id, {
    passwordHash: hash,
    passwordResetTokenHash: null,
    passwordResetExpires: null,
    refreshTokenHash: null,
  });
  return true;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  await connectDB();
  const user = await User.findById(userId).select("+passwordHash").lean();
  if (!user) return false;

  if (!verifyPassword(currentPassword, (user as unknown as Record<string, unknown>).passwordHash as string)) return false;

  const hash = hashPassword(newPassword);
  await User.findByIdAndUpdate(userId, {
    passwordHash: hash,
    refreshTokenHash: null,
  });
  return true;
}
