"use client";

import { useEffect } from "react";
import { startSyncEngine } from "@/lib/offline/sync-engine";

/**
 * Starts the offline sync engine once per app session (reconnect/visibility
 * triggers are registered inside startSyncEngine). Renders nothing.
 */
export function SyncBoot() {
  useEffect(() => {
    startSyncEngine();
  }, []);
  return null;
}
