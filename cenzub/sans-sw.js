// Le site figé sans service worker aux commandes : un lien partagé ouvert
// pour la première fois, ou un navigateur qui n'en a pas (celui intégré à une
// messagerie). La scène répondait alors 404 (vu le 25 novembre 2026). Ce
// script, chargé avant tout dans app.html et editeur.html, lit le manifeste
// et dirige vers data/ les demandes de fetch() et d'images qu'il connaît.
(() => {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) return;
  const base = new URL('./', location.href).href;
  let manifeste;
  try {
    // Synchrone : la page demande la scène dès son premier script.
    const x = new XMLHttpRequest();
    x.open('GET', base + 'manifeste.json', false);
    x.send();
    if (x.status !== 200) return;
    manifeste = JSON.parse(x.responseText);
  } catch (e) { return; }
  const versData = u => {
    try {
      const a = new URL(u, location.href).href.split('#')[0];
      if (!a.startsWith(base)) return null;     // le reste part au réseau, comme avec le service worker
      const entree = manifeste[a.slice(base.length)];
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
