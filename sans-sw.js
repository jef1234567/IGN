// Le site figé sans service worker aux commandes : un lien partagé ouvert
// pour la première fois, ou un navigateur qui n'en a pas (celui intégré à une
// messagerie). La scène répondait alors 404 (vu le 25 novembre 2026). Ce
// script, chargé avant tout dans app.html, lit le manifeste
// et dirige vers data/ les demandes de fetch() et d'images qu'il connaît.
(() => {
  const base = new URL('./', location.href).href;
  // Aux commandes, le service worker de ce dossier ; pas celui d'un site
  // parent (CENZUB, quand un camp est publié sous canjuers/).
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (sw && sw.scriptURL === base + 'sw.js') return;
  let manifeste;
  try {
    // Synchrone : la page demande la scène dès son premier script.
    const x = new XMLHttpRequest();
    x.open('GET', base + 'manifeste.json', false);
    x.send();
    if (x.status !== 200) return;
    manifeste = JSON.parse(x.responseText);
  } catch (e) { return; }
  // Un paquet de tuiles d'horizon dans le dossier ? (sa fiche, tuiles/zone.json)
  let paquet = false;
  try {
    const x = new XMLHttpRequest();
    x.open('HEAD', base + 'tuiles/zone.json', false);
    x.send();
    paquet = x.status === 200;
  } catch (e) { /* pas de paquet */ }
  const versData = u => {
    try {
      const a = new URL(u, location.href).href.split('#')[0];
      if (!a.startsWith(base)) return null;     // le reste part au réseau, comme avec le service worker
      const cle = a.slice(base.length);
      // L'orthophoto de l'horizon d'un camp (outils/paquet_horizon.py) ; les
      // altitudes, à l'IGN, partent au réseau.
      const o = /^api\/tuile\/ortho\/(\d+)\/(\d+)\/(\d+)$/.exec(cle);
      if (o && paquet) return `${base}tuiles/ortho/${o[1]}/${o[2]}/${o[3]}.jpg`;
      const entree = manifeste[cle];
      return entree ? base + 'data/' + entree[0] : null;
    } catch (e) { return null; }
  };
  const fetchOrigine = window.fetch;
  window.fetch = function (r, o) {
    const d = versData(typeof r === 'string' ? r : r instanceof URL ? r.href : r && r.url);
    return fetchOrigine.call(this, d || r, o);
  };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true, enumerable: src.enumerable, get: src.get,
    set(v) { src.set.call(this, versData(v) || v); },
  });
})();
