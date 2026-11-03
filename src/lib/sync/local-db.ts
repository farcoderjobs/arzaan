import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import type { LocalDatabaseInfo } from "./status-types";

/**
 * Capability probe for the database this process owns.
 *
 * Financial writes (a sale plus its inventory movements, ledger entries and cash
 * drawer movement) run inside a MongoDB transaction. Transactions require a
 * replica set — a single-node replica set is enough and is what the shop PC
 * should run (`mongod --replSet rs0` + `rs.initiate()`, see docs/OFFLINE.md).
 *
 * A standalone `mongod` still serves every read and every non-transactional
 * write; the probe exists so the Sync Center can say so plainly instead of
 * letting a sale fail with a driver error.
 */

export type { LocalDatabaseInfo };

const CACHE_TTL_MS = 60_000;

let cached: { value: LocalDatabaseInfo; expires: number } | null = null;

export async function probeLocalDatabase(force = false): Promise<LocalDatabaseInfo> {
  if (!force && cached && cached.expires > Date.now()) return cached.value;

  const value: LocalDatabaseInfo = {
    dbName: null,
    topology: null,
    transactionsSupported: null,
    standalone: false,
    checkedAt: null,
  };

  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (db) {
      value.dbName = db.databaseName;
      const hello = (await db.admin().command({ hello: 1 })) as {
        setName?: string;
        msg?: string;
        isWritablePrimary?: boolean;
      };
      value.topology = hello.msg === "isdbgrid" ? "mongos" : hello.setName ?? null;
      value.transactionsSupported = Boolean(hello.setName) || hello.msg === "isdbgrid";
      value.standalone = value.transactionsSupported === false;
      value.checkedAt = new Date().toISOString();
    }
  } catch (err) {
    console.error("[sync] local database probe failed", err);
  }

  cached = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Test helper: forget the cached probe result. */
export function clearLocalDatabaseProbe(): void {
  cached = null;
}
