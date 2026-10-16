import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { envSchema } from "@/config/env";

const resolvedEnv = envSchema.parse(process.env);

type SignPayload = { sub: string; role?: string; type?: string };

function jwtSign(payload: SignPayload, secret: string, options?: Record<string, unknown>): string {
  return jwt.sign({ ...payload }, secret, options) as string;
}

function jwtVerify(token: string): jwt.JwtPayload | string | null {
  try {
    return jwt.verify(token, secretOrPublicKey);
  } catch {
    return null;
  }
}

const secretOrPublicKey = resolvedEnv.JWT_SECRET;

export function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, 12);
}

export function verifyPassword(plaintext: string, hash: string): boolean {
  return bcrypt.compareSync(plaintext, hash);
}

export function createAccessToken(userId: string, roleId: string) {
  return jwtSign({ sub: userId, role: roleId }, secretOrPublicKey, { expiresIn: resolvedEnv.JWT_EXPIRES_IN });
}

export function createRefreshToken(userId: string) {
  return jwtSign({ sub: userId, type: "refresh" }, secretOrPublicKey, { expiresIn: resolvedEnv.JWT_REFRESH_EXPIRES_IN });
}

export function verifyAccessToken(token: string): jwt.JwtPayload | string | null {
  try {
    return jwtVerify(token);
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): jwt.JwtPayload | string | null {
  try {
    const payload = jwtVerify(token) as jwt.JwtPayload;
    if (payload.type !== "refresh") return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return bcrypt.hashSync(token, 10);
}

export function verifyTokenHash(token: string, hash: string): boolean {
  return bcrypt.compareSync(token, hash);
}

export function generateRandomToken(length = 32): string {
  let result = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
