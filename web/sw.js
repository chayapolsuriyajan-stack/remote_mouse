/* Caches the shell so the trackpad opens instantly (and the PWA installs).
   Everything that matters is live over the WebSocket, so there is nothing to
   sync here - a stale cache would only ever serve stale UI, hence the version
   bump-and-drop strategy below. */
var CACHE = "remote-mouse-v1";
var SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE; })
                           .map(function (key) { return caches.delete(key); }));
  }));
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(function () { return caches.match(event.request, { ignoreSearch: true }); })
  );
});
