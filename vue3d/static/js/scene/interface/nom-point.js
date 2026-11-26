// Le nom du point, au-dessus de ses coordonnées, et dans l'onglet.

import { POINT_DEFAUT, ACCUEIL, LAT0, LON0 } from '../socle/point.js';

// Le géocodage de la Géoplateforme, sans clé, appelé par le navigateur.
const URL_GEOCODAGE = 'https://data.geopf.fr/geocodage';
// Nom d'un lieu choisi autrefois dans la recherche (retirée le 25 novembre
// 2026), gardé pour l'onglet seulement.
const CLE_LIEU = 'vue3d-lieu';

// Nom du point : celui gardé pour ce point, sinon la commune, par géocodage
// inverse. Pas le lieu nommé le plus proche : il est trop souvent anodin — « Poste de gaz » à 48 m
// du point de Gardanne, « Poste de Gordes » avant le château, « Clocher » à
// Notre-Dame. Sans réponse, les coordonnées suffisent.
// L'onglet prend l'adresse postale du point, la plus proche selon le même
// géocodage : il n'en rend pas au-delà de 200 à 300 m (au château de
// Chambord, 190 m à 150 m au nord, rien à 300 m), et sur quinze lieux publics
// elle est à 2 à 126 m du point (l'Arc de Triomphe, Versailles). Le nom
// gardé la précède (« Arc de Triomphe — 9 Place Charles de
// Gaulle, 75116 Paris »), sauf s'il y est déjà : une adresse, une commune.
// Sans adresse, en forêt ou sur l'eau, l'onglet prend le nom du panneau.
(async () => {
    const nomPoint = document.getElementById('nom-point');
    let nom = ACCUEIL ? POINT_DEFAUT.nom : null, adresse = null;
    try {
        const l = JSON.parse(sessionStorage.getItem(CLE_LIEU) || 'null');
        if (l && Math.abs(l.lat - LAT0) < 1e-7 && Math.abs(l.lon - LON0) < 1e-7) nom = l.nom;
    } catch (e) { /* stockage refusé ou illisible */ }
    const choisi = nom;
    try {
        const r = await fetch(`${URL_GEOCODAGE}/reverse?` + new URLSearchParams({
            lat: LAT0, lon: LON0, index: 'address', limit: 1 }));
        const p = r.ok ? (((await r.json()).features || [])[0] || {}).properties : null;
        if (p && p.city) {
            const commune = p.postcode ? `${p.city} (${p.postcode})` : p.city;
            nom = nom || commune;
            adresse = p.name && p.name !== p.city ? `${p.name}, ${[p.postcode, p.city].filter(Boolean).join(' ')}` : commune;
        }
    } catch (e) { /* le nom n'est qu'un confort */ }
    if (nom) { nomPoint.textContent = nom; nomPoint.hidden = false; }
    const dedans = (a, b) => a.toLocaleLowerCase('fr').includes(b.toLocaleLowerCase('fr'));
    const titre = [...new Set([choisi && !(adresse && dedans(adresse, choisi)) ? choisi : null, adresse || nom])].filter(Boolean);
    if (titre.length) document.title = `${titre.join(' — ')} · Vue 3D IGN`;
})();
