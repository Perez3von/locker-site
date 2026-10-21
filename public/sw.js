/* Locker employee PWA: cache app shell/assets, never cache Firestore/API writes.
   Deploy as a same-origin file at /sw.js, scope /. */
const VERSION = "locker-offline-2026-10-21-v1";
const PAGES = `${VERSION}:pages`;
const ASSETS = `${VERSION}:assets`;
const APP_ROUTES = new Set(["/", "/wip"]);
const APP_SHELL = ["/", "/wip", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-icon.png"];

async function cacheResponse(cacheName, request, response) {
  if (response && response.ok && response.type !== "opaque") {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}

function findStaticAssets(html) {
  const urls = new Set();
  const regex = /(?:src|href)=["'](\/_next\/static\/[^"']+)["']/g;
  let found;
  while ((found = regex.exec(html)) !== null) {
    const path = found[1].replaceAll("&amp;", "&");
    if (path.startsWith("/_next/static/")) urls.add(path);
  }
  return [...urls];
}

async function installShell() {
  const pages = await caches.open(PAGES);
  const assets = await caches.open(ASSETS);
  const staticFiles = new Set();
  // Fail installation if either core route can't be cached. That prevents an
  // installed app from falsely claiming to be ready offline.
  for (const route of APP_ROUTES) {
    const response = await fetch(new Request(route, { cache: "reload", credentials: "same-origin" }));
    if (!response.ok) throw new Error(`Cannot cache offline page: ${route}`);
    await pages.put(route, response.clone());
    const html = await response.text();
    for (const path of findStaticAssets(html)) staticFiles.add(path);
  }
  const results = await Promise.allSettled([
    ...[...staticFiles, ...APP_SHELL.filter((path) => !APP_ROUTES.has(path))].map(async (path) => {
      const response = await fetch(new Request(path, { cache: "reload", credentials: "same-origin" }));
      if (response.ok) await assets.put(path, response);
    }),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    console.warn("Some optional Locker assets could not be precached; retrying when online.");
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Keep one previous cache generation in case an already-open tab still
    // references old hashed Next.js chunks during a deployment.
    const keys = (await caches.keys()).filter((key) => key.startsWith("locker-offline-") && key !== PAGES && key !== ASSETS);
    const oldPrefixes = [...new Set(keys.map((key) => key.split(":")[0]))].sort().reverse();
    for (const name of keys) {
      if (!oldPrefixes.slice(0, 1).some((prefix) => name.startsWith(prefix + ":"))) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      const cachedPage = APP_ROUTES.has(pathname) ? pathname : null;
      try {
        const response = await fetch(request);
        if (cachedPage) await cacheResponse(PAGES, cachedPage, response);
        return response;
      } catch (error) {
        if (!cachedPage) throw error;
        const offlinePage = await caches.match(cachedPage);
        if (offlinePage) return offlinePage;
        throw error;
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || /^\/(icon-\d+\.png|apple-icon\.png|manifest\.webmanifest)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      return cacheResponse(ASSETS, request, response);
    })());
  }
  // Next RSC requests and Firestore operations are intentionally network-only.
  // Offline navigation uses ordinary <a> links to load cached HTML instead.
});
