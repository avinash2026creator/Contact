/**
 * CraneCall v2 – Service Worker
 * Strategy:
 *   App shell (HTML/CSS/JS/manifest) → Cache-first with background update
 *   Apps Script API                  → Network-only (never cache mutations)
 *   Icons                            → Cache-first (long-lived)
 */

const CACHE_VERSION = 'cranecall-v2.0';
const SHELL_ASSETS  = [
  './',
  './index.html',
  './manifest.json',
];

// ── Install: pre-cache app shell ──────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: evict old caches ────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 1. Google Apps Script API — always network, never cache
  //    POST mutations must never be served from cache
  if (url.hostname.includes('script.google.com')) {
    if (e.request.method === 'POST') {
      // Network-only, no fallback — offline mutations must fail loudly
      e.respondWith(
        fetch(e.request).catch(() =>
          new Response(JSON.stringify({ ok: false, error: 'Offline – changes cannot be saved right now.' }), {
            headers: { 'Content-Type': 'application/json' }
          })
        )
      );
    } else {
      // GET requests — network first, no stale cache fallback for API
      e.respondWith(fetch(e.request).catch(() =>
        new Response(JSON.stringify({ ok: false, error: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      ));
    }
    return;
  }

  // 2. Non-GET (e.g., POST to other origins) — network only
  if (e.request.method !== 'GET') return;

  // 3. App shell and icons — cache first, update in background (stale-while-revalidate)
  e.respondWith(
    caches.open(CACHE_VERSION).then(async cache => {
      const cached = await cache.match(e.request);

      // Kick off network fetch in background to keep cache fresh
      const networkFetch = fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            cache.put(e.request, res.clone());
          }
          return res;
        })
        .catch(() => null);

      // Return cached immediately if we have it, otherwise wait for network
      if (cached) {
        // Serve cached, let network update run in background
        networkFetch; // fire-and-forget
        return cached;
      }

      // No cache — must wait for network
      const networkRes = await networkFetch;
      if (networkRes) return networkRes;

      // Total offline fallback: return index.html for navigation requests
      if (e.request.mode === 'navigate') {
        return cache.match('./index.html');
      }

      return new Response('Offline', { status: 503 });
    })
  );
});

// ── Message: force update ─────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
