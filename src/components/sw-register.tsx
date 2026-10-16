"use client";

import { useEffect } from "react";

const SHELL_CACHE_PREFIX = "pos-shell-";

/** Registers /sw.js once the page has finished loading (keeps first paint fast). */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // registration failures are non-fatal (private mode, unsupported…)
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}

/**
 * Drops cached page shells (called on logout so a shared device doesn't keep
 * rendering another user's pages offline). The IndexedDB sync queue and
 * catalog cache are deliberately NOT cleared — they hold unsent sales.
 */
export async function clearAppShellCache(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(SHELL_CACHE_PREFIX)).map((k) => caches.delete(k)));
  } catch {
    // non-fatal
  }
}
