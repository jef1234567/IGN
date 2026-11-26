// Rejoue les réponses enregistrées par figer.mjs : la scène fonctionne sans
// serveur Python et sans réseau. Ce qui n'a pas été enregistré part au réseau.
//
// Les tuiles de l'horizon rangées par outils/paquet_horizon.py (tuiles/…)
// passent avant : orthophoto et altitudes du RGE ALTI sur toute une zone,
// pour survoler un camp entier hors réseau. Absente du dossier, une tuile
// suit le chemin d'avant (manifeste, puis réseau).
const BASE = new URL('./', self.registration.scope).href;
let manifeste = null;

async function lireManifeste() {
  if (!manifeste) manifeste = await (await fetch(BASE + 'manifeste.json', { cache: 'no-cache' })).json();
  return manifeste;
}

const ORTHO = /^api\/tuile\/ortho\/(\d+)\/(\d+)\/(\d+)(\?|$)/;
const ALTI = 'https://data.geopf.fr/wmts?';

/** Le fichier du paquet de tuiles pour une adresse, et son type ; sinon null. */
function fichierTuile(cle) {
  const o = ORTHO.exec(cle);
  if (o) return [`tuiles/ortho/${o[1]}/${o[2]}/${o[3]}.jpg`, 'image/jpeg'];
  if (!cle.startsWith(ALTI)) return null;
  const p = new URL(cle).searchParams;
  if (p.get('LAYER') !== 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES' || p.get('TILEMATRIXSET') !== 'WGS84G_6_14') return null;
  return [`tuiles/alti/${p.get('TILEMATRIX')}/${p.get('TILEROW')}/${p.get('TILECOL')}.bil`, 'image/x-bil;bits=32'];
}

// Une page ouverte sur un point que ce dossier n'a pas enregistré (lien
// gardé d'une version précédente, ou index.html resté 10 min dans le cache
// HTTP de GitHub Pages après une republication) affichait « Scène
// indisponible » : renvoyée à l'entrée, relue sans cache, qui porte le point
// du dossier. Seulement si le dossier a une scène, sans quoi elle bouclerait.
async function naviguer(requete, cle) {
  const page = /^(app|editeur)\.html\?/.exec(cle);
  if (page) {
    const p = new URL(requete.url).searchParams;
    // Relu à chaque ouverture : un service worker resté en vie pendant une
    // republication garderait l'ancien et renverrait sans fin à l'entrée.
    const frais = await fetch(BASE + 'manifeste.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => null);
    if (frais) manifeste = frais;
    const m = manifeste || {};
    // L'adresse que la page demandera : celle de demanderScene (index.html de
    // l'application), nombres relus et zone arrondie, 1 000 m sans zone=.
    const lire = n => { const v = Number(String(p.get(n) || '').replace(',', '.')); return p.get(n) !== null && Number.isFinite(v) ? v : null; };
    const lat = lire('lat'), lon = lire('lon'), zone = lire('zone') ?? 1000;
    const scene = `api/scene?lat=${lat}&lon=${lon}&zone=${Math.min(Math.max(Math.round(zone / 50) * 50, 150), 2000)}`;
    if (lat !== null && lon !== null && !m[scene] && Object.keys(m).some(k => k.startsWith('api/scene?'))) {
      return Response.redirect(BASE + 'index.html', 302);
    }
  }
  if (cle === '' || cle.startsWith('index.html')) return fetch(requete.url, { cache: 'no-cache' });
  return fetch(requete);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = e.request.url.split('#')[0];
  const cle = u.startsWith(BASE) ? u.slice(BASE.length) : u;
  if (e.request.mode === 'navigate') { e.respondWith(naviguer(e.request, cle)); return; }
  e.respondWith((async () => {
    const tuile = fichierTuile(cle);
    if (tuile) {
      const r = await fetch(BASE + tuile[0]).catch(() => null);
      if (r && r.ok) return new Response(r.body, { status: 200, headers: { 'Content-Type': tuile[1] } });
    }
    const m = await lireManifeste();
    const entree = m[cle];
    if (!entree) return fetch(e.request);
    const r = await fetch(BASE + 'data/' + entree[0]);
    return new Response(r.body, { status: 200, headers: { 'Content-Type': entree[1] } });
  })());
});
