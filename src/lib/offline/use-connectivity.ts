"use client";

import { useSyncExternalStore, useEffect } from "react";
import {
  getConnectivitySnapshot,
  startConnectivity,
  subscribeConnectivity,
} from "./connectivity";

/**
 * React binding for the connectivity service. Starts the watcher on first
 * mount and re-renders on every status change.
 */
export function useConnectivity() {
  useEffect(() => {
    startConnectivity();
  }, []);

  return useSyncExternalStore(subscribeConnectivity, getConnectivitySnapshot, getConnectivitySnapshot);
}
