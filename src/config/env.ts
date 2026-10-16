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

export const envSchema = z.object({
  MONGODB_URI: z.string().url().startsWith("mongodb://").or(z.string().url().startsWith("mongodb+srv://")),
  MONGODB_DB_NAME: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().min(1),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1),
  APP_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;
