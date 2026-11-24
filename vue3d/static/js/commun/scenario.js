// Le format du calque scénario, commun à la vue 3D (couches/scenario.js) et à
// l'éditeur 2D (editeur/main.js) : rien que des constantes et des fonctions.
//
// scenario.json (outils/scenario.py pour le tableur, l'éditeur pour la carte) :
//   { format, version, titre, date, debut, fin, vent: { de, vitesse },
//     points: { nom: { lat, lon } },
//     evenements: [ { id, type, debut, fin?, libelle?, lat?, lon?, params? } ] }
// Les heures sont des secondes depuis 00:00 du jour du scénario.
//
// Une unité porte son itinéraire, des points horodatés (action : « assaut »,
// « appui feu »… ce que l'unité fait à partir de ce point) :
//   params: { camp, arme, echelon, pc, sidc, vitesse_kmh,
//             trajet: [ { t, lat, lon, action? } ] }
// Un tracé de manœuvre (limite, flèche, zone), visible de debut à fin :
//   params: { forme: ligne|fleche|zone, camp, points: [ { lat, lon } ] }
// Une phase : debut, fin, libelle. `heure_h`, facultative : l'heure H, d'où
// les heures relatives (H+20).
// Le code SIDC (MIL-STD-2525C / APP-6, en lettres) est écrit en entier, pour
// qu'un outil tiers (un OPO traduit en scénario) puisse donner le sien sans
// passer par ces listes.

export const FORMAT = 'scenario-cenzub';
export const VERSION = 1;

export const COULEURS_FUMEE = {
    blanc: '#e6e6e2', rouge: '#d0402e', vert: '#46a752', jaune: '#e2c43a',
    violet: '#8a52c2', orange: '#ec8a2c', noir: '#2c2c2c',
};
export const DUREE_FUMIGENE_S = 120;
export const TAILLE_FUMIGENE_M = 15;

export const CAMPS = { ami: 'F', ennemi: 'H' };
// Fonction de l'unité, positions 5 à 10 du SIDC (forces terrestres, unités).
export const ARMES = {
    infanterie: ['Infanterie', 'UCI---'],
    meca: ['Infanterie mécanisée', 'UCIZ--'],
    blinde: ['Blindé', 'UCA---'],
    reco: ['Reconnaissance', 'UCR---'],
    genie: ['Génie', 'UCE---'],
    artillerie: ['Artillerie', 'UCF---'],
    sol_air: ['Défense sol-air', 'UCD---'],
    soutien: ['Soutien', 'US----'],
};
// Échelon, position 12 du SIDC.
export const ECHELONS = {
    equipe: ['Équipe', 'A'], groupe: ['Groupe', 'B'], section: ['Section', 'D'],
    compagnie: ['Compagnie', 'E'], bataillon: ['Bataillon / GTIA', 'F'],
    regiment: ['Régiment', 'G'], brigade: ['Brigade', 'H'],
};

// Allure sur l'itinéraire, quand un point est ajouté sans avancer la frise :
// son heure vient de la distance au point précédent. Ordres de grandeur
// d'une progression en zone urbaine, à corriger unité par unité.
export const VITESSES_KMH = {
    infanterie: 2, meca: 10, blinde: 10, reco: 15, genie: 2, artillerie: 10, sol_air: 10, soutien: 10,
};

export const FORMES = { ligne: ['Limite / ligne'], fleche: ['Flèche'], zone: ['Zone / objectif'] };
export const COULEURS_CAMP = { ami: '#3b82e6', ennemi: '#e0533f', neutre: '#1c1c1c' };

/** SIDC à 15 lettres : S, camp, G (terrestre), P (présent), fonction, PC, échelon. */
export function sidc({ camp = 'ami', arme = 'infanterie', echelon = 'section', pc = false } = {}) {
    return `S${CAMPS[camp] || 'F'}GP${(ARMES[arme] || ARMES.infanterie)[1]}`
        + `${pc ? 'A' : '-'}${(ECHELONS[echelon] || ECHELONS.section)[1]}---`;
}

/**
 * Position d'une unité à l'instant t : interpolée entre deux points de son
 * itinéraire, immobile avant le premier et après le dernier. `cap` en degrés
 * (0 nord, 90 est) ; `avant` vrai tant que l'unité n'est pas encore entrée.
 */
export function positionUnite(ev, t) {
    const trajet = (ev.params && ev.params.trajet) || [];
    if (!trajet.length) return ev.lat != null ? { lat: ev.lat, lon: ev.lon, cap: 0, avant: t < ev.debut } : null;
    let i = 0;
    while (i < trajet.length - 1 && trajet[i + 1].t <= t) i++;
    const a = trajet[i], b = trajet[Math.min(i + 1, trajet.length - 1)];
    const f = b.t > a.t ? Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1) : 0;
    const lat = a.lat + (b.lat - a.lat) * f, lon = a.lon + (b.lon - a.lon) * f;
    const cap = (Math.atan2((b.lon - a.lon) * Math.cos(lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
    return { lat, lon, cap, avant: t < trajet[0].t };
}

/** 06:30:00, et (J+1) le lendemain. */
export function texteHeure(s, secondes = true) {
    const j = Math.floor(s / 86400), r = ((s % 86400) + 86400) % 86400;
    const hm = `${String(Math.floor(r / 3600)).padStart(2, '0')}:${String(Math.floor(r / 60) % 60).padStart(2, '0')}`;
    return hm + (secondes ? `:${String(Math.floor(r) % 60).padStart(2, '0')}` : '') + (j > 0 ? ' (J+1)' : '');
}

/** H+20, H-05, H+1h05 : l'heure relative à l'heure H. */
export function texteRelatif(s, h) {
    if (h == null) return '';
    const d = Math.round((s - h) / 60), a = Math.abs(d);
    return `H${d < 0 ? '-' : '+'}${a >= 60 ? `${Math.floor(a / 60)}h${String(a % 60).padStart(2, '0')}` : String(a).padStart(2, '0')}`;
}

/** La phase en cours à l'instant t, ou null. */
export function phaseEnCours(scenario, t) {
    return scenario.evenements.find(e => e.type === 'phase' && t >= e.debut && t < (e.fin ?? e.debut)) || null;
}

/** Distance en mètres entre deux points proches. */
export function distanceM(a, b) {
    const dy = (b.lat - a.lat) * 111320, dx = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dx, dy);
}

/** « 06:30 » → secondes ; une heure avant `debut` est celle du lendemain. */
export function lireHeure(texte, debut = 0) {
    const m = /^\s*(\d{1,2})\s*[:hH]\s*(\d{2})(?:\s*:\s*(\d{2}))?\s*$/.exec(texte || '');
    if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
    const s = +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0);
    return s < debut ? s + 86400 : s;
}

export function verifierScenario(s) {
    if (!s || s.format !== FORMAT) throw new Error('ce fichier n’est pas un scénario');
    if (s.version !== VERSION) throw new Error(`version ${s.version} du format, la page lit la ${VERSION}`);
    if (!(s.fin >= s.debut) || !Array.isArray(s.evenements)) throw new Error('scénario mal formé');
    return s;
}

// Le brouillon de l'éditeur, que la vue 3D ouvre avec ?scenario=brouillon.
export const CLE_BROUILLON = 'cenzub-scenario-brouillon';
