// Rejoue les réponses enregistrées par figer.mjs : la scène fonctionne sans
// serveur Python et sans réseau. Ce qui n'a pas été enregistré part au réseau.
const BASE = new URL('./', self.registration.scope).href;
let manifeste = null;

async function lireManifeste() {
  if (!manifeste) manifeste = await (await fetch(BASE + 'manifeste.json', { cache: 'no-cache' })).json();
  return manifeste;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = e.request.url.split('#')[0];
  const cle = u.startsWith(BASE) ? u.slice(BASE.length) : u;
  e.respondWith((async () => {
    const m = await lireManifeste();
    const entree = m[cle];
    if (!entree) return fetch(e.request);
    const r = await fetch(BASE + 'data/' + entree[0]);
    return new Response(r.body, { status: 200, headers: { 'Content-Type': entree[1] } });
  })());
});
