/**
 * App-shell service worker (offline-first POS).
 *
 * Policy:
 *  - API (/api/*) is NEVER cached or intercepted — sales/products data flows
 *    only through the app's IndexedDB layer with explicit idempotent sync.
 *  - Hashed static assets (/_next/static/) → cache-first (immutable).
 *  - Navigations → network-first; offline falls back to the cached copy of
 *    the page, then to the offline page, then a plain-text 503.
 *  - POST/PUT/DELETE and cross-origin requests are untouched.
 */

const SHELL_CACHE = "pos-shell-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .catch(() => undefined)
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pos-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept mutations

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: untouched
  if (url.pathname.startsWith("/api/")) return; // API: always real network
  if (url.pathname === "/sw.js") return;

  // Hashed build assets: cache-first (content is immutable per URL).
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Pages: network-first so the shell is always fresh when online.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          const shell = await caches.match(OFFLINE_URL);
          if (shell) return shell;
          return new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        })
    );
  }
});
