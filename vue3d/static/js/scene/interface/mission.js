// Préparation de mission : des postes posés sur le terrain ou aux étages des
// bâtiments, ce qu'ils voient, ce que leur arme peut traiter et qui les voit,
// la ligne de vue vers un point avec son profil, la vue depuis l'optique, et
// les mesures (distance, azimut en millièmes, dénivelé, MGRS).
//
// Tout se calcule sur ce que la scène montre : relief, anneau, bâtiments et
// végétation affichés. Masquer la végétation (son bouton) revient donc à
// voir à travers elle. La carte des vues tient dans une carte de distances
// cubique rendue depuis chaque poste, comme l'ombre d'une lampe : un point
// est vu si rien n'est plus proche du poste dans sa direction. La ligne de vue
// est un lancer de rayon sur les mêmes objets, et dit ce qui masque.
//
// La visibilité est réciproque : la droite qui joint mon optique au point
// exposé de l'ennemi est celle de « ce que je vois » ; celle qui joint mon
// point exposé à son optique, celle de « qui me voit ». Les deux cartes ne
// diffèrent que par ces hauteurs.

import * as THREE from 'three';
import { scene, camera, renderer, controls, host } from '../socle/rendu.js';
import { toLonLat, toLocal } from '../socle/projection.js';
import { terrain, anneauRelief, altitudeRef, exagVert, relief } from '../terrain/etat.js';
import { tuilesMontrees } from '../terrain/horizon.js';
import { reliefDeCalcul, reliefCouvre, maillageCalcul, ySolCalcul, chute } from './reliefcalcul.js';
import { groupeBatiments } from '../batiments/etat.js';
import { groupeBatiCamp } from './batiments-camp.js';
import { groupeVegetation } from '../vegetation/etat.js';
import { groupeVegSimple } from '../vegetation/couche.js';
import { prendreLeClic, prendreLaMolette } from './gestes.js';
import { orbite, arreterOrbite } from './boutons.js';
import { droneActif } from './drone.js';
import { versMgrs, azimutMilliemes, convergenceMilliemes } from '../../commun/mgrs.js';

const $ = id => document.getElementById(id);

// Par type : hauteur de l'optique (œil, épiscope, viseur) et du point le plus
// haut qui dépasse (tête, toit de tourelle), en mètres au-dessus du sol ou du
// plancher ; débattement en site de l'arme principale, en degrés (le
// millième n'est donné qu'à côté), null sans limite utile. Les hauteurs sont
// des ordres de grandeur ; les débattements viennent de sources ouvertes,
// lues le 26 novembre 2026 :
//   Leclerc, canon CN120-26 : −8° à +20° (Wikipédia anglaise, « AMX Leclerc »).
//   VBCI, canon 25M811 en tourelle DRAGAR : −8° à +45° (Army Guide, fiche
//     « 25 M811 »). Fiche du fabricant (KNDS) muette.
//   Jaguar, canon 40 CTA en tourelle T40 : −10° à +45° (Wikipédia anglaise,
//     « 40CT cannon », pour le Jaguar). La T40 du VBCI Mk2 monte à +60°
//     (fiche KNDS) : pas la même tourelle.
//   Griffon, tourelleau téléopéré T1 Hornet (Arquus) : −20° à +60°
//     (Wikipédia anglaise, « VBMR Griffon »).
//   MMP : aucune source ouverte sur un débattement ; sans limite.
const TYPES = [
    { nom: 'Fantassin couché', optique: 0.4, expo: 0.5, site: null },
    { nom: 'Fantassin à genou', optique: 1.0, expo: 1.2, site: null },
    { nom: 'Fantassin debout', optique: 1.6, expo: 1.8, site: null },
    { nom: 'Poste MMP au sol', optique: 0.5, expo: 0.7, site: null },
    { nom: 'VBCI', optique: 2.6, expo: 3.0, site: [-8, 45] },
    { nom: 'Griffon', optique: 2.9, expo: 3.3, site: [-20, 60] },
    { nom: 'Jaguar', optique: 2.6, expo: 3.0, site: [-10, 45] },
    { nom: 'Leclerc', optique: 2.3, expo: 2.5, site: [-8, 20] },
    // Griffon VOA (observation d'artillerie) : l'optique en tête de mât,
    // 3,5 m au-dessus du toit (2,9 m), valeur donnée par Jean-François le
    // 26 novembre 2026 ; aucune source ouverte trouvée. Pas d'arme à juger.
    { nom: 'Griffon VOA, mât levé', optique: 6.4, expo: 6.6, site: null },
];
const TYPE_FENETRE = 2;               // posé à un étage : debout à la fenêtre
const TYPE_DEFAUT = 4;
const HAUTEUR_ETAGE = 3;              // m de plancher à plancher
const MAX_POSTES = 4;
const COULEURS_POSTES = [0x2f80ed, 0xbb6bd9, 0x27ae60, 0xf2994a];
const hexa = c => '#' + c.toString(16).padStart(6, '0');

const btnPoser = $('mi-poser'), btnDeplacer = $('mi-deplacer'), btnLdv = $('mi-ldv'), btnMesurer = $('mi-mesurer');
const btnVues = $('mi-vues'), btnVu = $('mi-vu'), btnRegard = $('mi-regard');
const note = $('mi-note'), resultat = $('mi-resultat'), profil = $('mi-profil');
const listePostes = $('mi-postes'), selType = $('mi-type-moi'), selEtage = $('mi-etage');
const champs = {
    optique: $('mi-optique-moi'), expo: $('mi-expo-moi'), siteMin: $('mi-site-min'), siteMax: $('mi-site-max'),
};
const NOTE_DEPART = note.textContent;

// --- Le sol sous le pointeur, les obstacles -------------------------------------

const rayon = new THREE.Raycaster();
function visible(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    // Les volumes gardés pour la fiche d'un ouvrage ajouré, dessiné en
    // points (couches/nuage), ont un matériau invisible : ni obstacle ni calque.
    const m = o.material;
    return !(Array.isArray(m) ? m.every(x => x.visible === false) : m && m.visible === false);
}
// Le sol des calculs : la scène, l'anneau, et au-delà le relief de calcul
// (interface/reliefcalcul.js), au niveau fixe. Un clic vise aussi l'horizon
// affiché : sur un camp vaste, c'est presque tout le sol.
const sols = () => [terrain && terrain.mesh, anneauRelief && anneauRelief.mesh, maillageCalcul()].filter(Boolean);
const solsVises = () => sols().concat(tuilesMontrees());
function batis() {
    const liste = [];
    // Les bâtiments de la scène, et ceux de tout le camp sur la vue
    // d'ensemble (interface/batiments-camp.js).
    for (const g of [groupeBatiments, groupeBatiCamp]) {
        g.traverse(o => { if (o.isMesh && visible(o)) liste.push(o); });
    }
    return liste;
}
/** Ce qui peut masquer : le sol, et les bâtiments et la végétation affichés. */
function obstacles() {
    const liste = sols().concat(batis());
    for (const g of [groupeVegetation, groupeVegSimple]) {
        g.traverse(o => { if (o.isMesh && visible(o)) liste.push(o); });
    }
    return liste;
}
function natureObstacle(o) {
    if (sols().includes(o)) return 'le relief';
    for (let p = o; p; p = p.parent) {
        if (p === groupeVegetation || p === groupeVegSimple) return 'la végétation';
    }
    return 'un bâtiment';
}
/** Point du sol en (x, z) de la scène : { x, z, y, lon, lat, base: 0 }, ou null. */
function pointAuSol(x, z) {
    const [lon, lat] = toLonLat(x, -z);
    const y = ySolCalcul(lon, lat, x, z);
    return y == null ? null : { x, z, y, lon, lat, base: 0, bati: null };
}
// Posé sur une façade, le point est écarté du mur de 0,6 m vers l'extérieur :
// l'œil à la fenêtre, que le mur lui-même ne masque pas.
const ECART_FACADE = 0.6;
/**
 * Point visé par la souris (coordonnées normalisées), ou null. Sur un
 * bâtiment (`avecBati`), `base` est la hauteur du plancher au-dessus du sol :
 * l'étage de la façade touchée, ou le toit ; `bati` dit lequel.
 */
function pointSous(souris, avecBati) {
    rayon.setFromCamera(souris, camera);
    rayon.near = 0; rayon.far = Infinity;
    const t = rayon.intersectObjects(avecBati ? solsVises().concat(batis()) : solsVises(), false)[0];
    if (!t) return null;
    if (solsVises().includes(t.object)) return pointAuSol(t.point.x, t.point.z);
    const n = t.face ? t.face.normal.clone().transformDirection(t.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    // Un toit : on s'y tient. Le signe de la normale ne compte pas : certains
    // toits sont tournés vers le bas (ordre de leurs sommets), et leur normale
    // horizontale nulle donnait un point hors de la scène, refusé. 0,35 garde
    // les pans jusqu'à 70° ; une façade est verticale.
    if (Math.abs(n.y) >= 0.35) {
        const p = pointAuSol(t.point.x, t.point.z);
        if (!p) return null;
        return { ...p, base: Math.max(0, t.point.y - p.y), bati: { toit: true, etages: 0 } };
    }
    const h = new THREE.Vector2(n.x, n.z).normalize().multiplyScalar(ECART_FACADE);
    const p = pointAuSol(t.point.x + h.x, t.point.z + h.y);
    if (!p) return null;
    let haut;
    if (t.object.userData.hautDe && t.face) haut = t.object.userData.hautDe(t.face.a);   // bâtiments du camp
    else {
        t.object.geometry.computeBoundingBox();
        haut = new THREE.Vector3(0, t.object.geometry.boundingBox.max.y, 0).applyMatrix4(t.object.matrixWorld).y;
    }
    const etages = Math.max(1, Math.floor((haut - p.y) / HAUTEUR_ETAGE));
    const etage = Math.min(Math.max(0, Math.floor((t.point.y - p.y) / HAUTEUR_ETAGE)), etages - 1);
    // Le cap de la façade, vers l'extérieur : la vue depuis la fenêtre part de là.
    const dehors = Math.atan2(h.x, -h.y);
    return { ...p, base: etage * HAUTEUR_ETAGE, bati: { toit: false, etages, etage, dehors } };
}
/** Altitude vraie d'un Y de la scène (exagération à 1, vérifiée avant). */
const altitude = y => y + altitudeRef;
/** Altitude vraie du plancher d'un point, courbure de la Terre rendue. */
const altitudePoint = p => p.y + p.base + altitudeRef + chute(p.lon, p.lat, p.x, p.z);
const enHaut = (p, h) => new THREE.Vector3(p.x, p.y + p.base + h, p.z);

const HORS_RELIEF = 'Ce clic ne tombe sur aucun relief chargé : rapproche-toi, ou attends que l’horizon se charge.';

/**
 * Vrai si le relief de calcul couvre les points (à `marge` m près) ; sinon il
 * est lu, les points non posés sur un bâtiment sont recalés sur lui, puis
 * `ensuite` est rappelé.
 */
function reliefPret(points, marge, ensuite, zone = note) {
    const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const p of points) {
        b.x0 = Math.min(b.x0, p.x - marge); b.x1 = Math.max(b.x1, p.x + marge);
        b.z0 = Math.min(b.z0, p.z - marge); b.z1 = Math.max(b.z1, p.z + marge);
    }
    if (reliefCouvre(b)) return true;
    zone.textContent = 'Lecture du relief alentour…';
    reliefDeCalcul(b).then(() => {
        for (const p of points) recaler(p);
        ensuite();
    }, e => { zone.textContent = `Relief alentour illisible (${e.message}) : calcul impossible.`; });
    return false;
}
/** Le point repris sur le sol des calculs, s'il n'est pas sur un bâtiment. */
function recaler(p) {
    if (p.bati) return;
    const q = pointAuSol(p.x, p.z);
    if (q) p.y = q.y;
}

/** Une raison de ne rien calculer, ou null. */
function empechement() {
    if (!terrain) return 'Le relief n’est pas encore chargé.';
    if (!relief || exagVert !== 1) return 'Remets le relief et l’exagération Z à 1 : les hauteurs seraient fausses.';
    return null;
}

/**
 * Lance la droite de `de` à `vers` (deux Vector3) ; rend le premier obstacle,
 * { distance, point, nature }, ou null si elle passe. Les 0,3 m du bout sont
 * ignorés : la droite y touche le sol d'une cible posée à ras de terre.
 */
function premierObstacle(de, vers) {
    const d = vers.clone().sub(de), L = d.length();
    if (L < 0.5) return null;
    rayon.set(de, d.divideScalar(L));
    rayon.near = 0.05;
    rayon.far = L - 0.3;
    const t = rayon.intersectObjects(obstacles(), false)[0];
    return t ? { distance: t.distance, point: t.point, nature: natureObstacle(t.object) } : null;
}

// --- Marqueurs et traits ----------------------------------------------------------

const groupe = new THREE.Group();
scene.add(groupe);
const COULEUR_LUI = 0xe5534b, COULEUR_MESURE = 0xf2c94c;
const VERT = 0x4cc26b, ROUGE = 0xe5534b;

function marqueur(couleur) {
    // Mât du sol à l'optique, boule à l'optique, anneau au sol ; et la même
    // boule, pâle, revue à travers tout pour la retrouver derrière une crête.
    const plein = new THREE.MeshBasicMaterial({ color: couleur });
    const pale = new THREE.MeshBasicMaterial({ color: couleur, transparent: true, opacity: 0.35, depthTest: false });
    const sol = new THREE.MeshBasicMaterial({ color: couleur, transparent: true, opacity: 0.6, depthWrite: false });
    const mat = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 8), plein);
    const boule = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 8), plein);
    const fantome = new THREE.Mesh(boule.geometry, pale);
    fantome.renderOrder = 20;
    const anneau = new THREE.Mesh(new THREE.RingGeometry(1.2, 2.2, 32), sol);
    anneau.rotation.x = -Math.PI / 2;
    anneau.position.y = 0.15;
    const g = new THREE.Group();
    g.add(mat, boule, fantome, anneau);
    g.userData.parties = { mat, boule, fantome, anneau };
    g.visible = false;
    groupe.add(g);
    return g;
}
/** Pose un marqueur au point p, optique à h mètres au-dessus de son plancher. */
function placer(m, p, h) {
    const { mat, boule, fantome, anneau } = m.userData.parties;
    m.position.set(p.x, p.y, p.z);
    const haut = p.base + h;
    mat.scale.y = Math.max(haut, 0.05);
    mat.position.y = haut / 2;
    boule.position.y = fantome.position.y = haut;
    anneau.position.y = p.base + 0.15;
    m.visible = true;
}
function oter(m) {
    groupe.remove(m);
    m.traverse(o => { if (o.isMesh) o.material.dispose(); });
}
const marqueurCible = marqueur(COULEUR_LUI);
const marqueurA = marqueur(COULEUR_MESURE), marqueurB = marqueur(COULEUR_MESURE);
// Vus de haut, une boule de 0,6 m et un anneau de 2 m se perdent : ils
// grossissent avec la distance à la caméra, au-delà de 120 m.
function grossirMarqueurs() {
    for (const m of groupe.children) {
        if (!m.visible || !m.userData.parties) continue;
        const k = Math.max(1, camera.position.distanceTo(m.position) / 120);
        const { boule, fantome, anneau } = m.userData.parties;
        boule.scale.setScalar(k);
        fantome.scale.setScalar(k);
        anneau.scale.set(k, k, 1);
    }
    requestAnimationFrame(grossirMarqueurs);
}
requestAnimationFrame(grossirMarqueurs);

/** Un trait de points (Vector3), couleur unie ; remplace celui de même nom. */
const traits = new Map();
function tracer(nom, points, couleur) {
    effacerTrait(nom);
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const ligne = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: couleur, depthTest: false, transparent: true }));
    ligne.renderOrder = 21;
    groupe.add(ligne);
    traits.set(nom, ligne);
}
function effacerTrait(nom) {
    const l = traits.get(nom);
    if (!l) return;
    groupe.remove(l);
    l.geometry.dispose();
    l.material.dispose();
    traits.delete(nom);
}
/** Les points du sol de a à b, relevés de dh : un trait drapé sur le relief. */
function drape(a, b, n, dh) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = pointAuSol(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
        if (p) pts.push(new THREE.Vector3(p.x, p.y + dh, p.z));
    }
    return pts;
}

// --- Mesures ------------------------------------------------------------------------

const fmt = (v, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signe = (v, d = 0) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;
const ligneStat = (nom, valeur, classe = '') =>
    `<div class="stat"><span>${nom}</span><b${classe ? ` class="${classe}"` : ''}>${valeur}</b></div>`;
/** Distance, azimut et dénivelé de a vers b, au niveau de leurs planchers. */
// La scène est une équirectangulaire à 111 320 m le degré (socle/projection) :
// juste à quelques centaines de mètres, mais un degré de latitude vaut
// 111 206 m à 49,5° N (+0,1 %), et sur un camp de 35 km le cosinus du
// centre fausse l'est-ouest de 0,14 % à 10 km au nord. Les mesures partent
// donc des longitudes et latitudes, sur les rayons de courbure de WGS 84 à la
// latitude moyenne : 1 m sur 30 km.
const A_WGS84 = 6378137, E2_WGS84 = 0.00669437999014;
function ecartMetres(a, b) {
    const phi = (a.lat + b.lat) / 2 * Math.PI / 180, s = Math.sin(phi);
    const w = Math.sqrt(1 - E2_WGS84 * s * s);
    const M = A_WGS84 * (1 - E2_WGS84) / (w * w * w), N = A_WGS84 / w;
    return [(b.lon - a.lon) * Math.PI / 180 * N * Math.cos(phi), (b.lat - a.lat) * Math.PI / 180 * M];
}
function mesure(a, b) {
    const [de, dn] = ecartMetres(a, b);
    const horizontale = Math.hypot(de, dn), denivele = altitudePoint(b) - altitudePoint(a);
    return {
        horizontale, denivele,
        milliemes: azimutMilliemes(de, dn),
        degres: ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360,
        pente: horizontale > 0 ? 100 * denivele / horizontale : 0,
    };
}
function lignesMesure(a, b) {
    const m = mesure(a, b);
    return ligneStat('distance au sol', `${fmt(m.horizontale)} m`)
        + ligneStat('azimut vrai', `${fmt(Math.round(m.milliemes) % 6400)} ‰ · ${fmt(m.degres, 1)}°`)
        + ligneStat('azimut carroyage', `${fmt(Math.round(m.milliemes - convergenceMilliemes(a.lon, a.lat) + 6400) % 6400)} ‰`)
        + ligneStat('dénivelé', `${signe(m.denivele, 1)} m (pente ${fmt(m.pente, 1)} %)`);
}
const ouEst = p => !p.bati ? '' : p.bati.toit ? ' · toit' : p.bati.etage ? ` · ${p.bati.etage === 1 ? '1er' : p.bati.etage + 'e'} étage` : ' · rez-de-chaussée';
const lignePoint = (nom, p) =>
    ligneStat(nom, `${versMgrs(p.lon, p.lat) || '—'} · ${fmt(altitudePoint(p))} m${ouEst(p)}`);

// --- Postes ----------------------------------------------------------------------------
// Un poste : son point, son type, ses hauteurs et son débattement (repris du
// type, corrigeables), son marqueur. Le choisi est celui des champs, de la
// ligne de vue et de la vue du poste ; la carte les réunit tous, ou lui seul.

const postes = [];
let choisi = null;
let numero = 0;

function nouveauPoste(p) {
    const type = p.bati ? TYPE_FENETRE : TYPE_DEFAUT;
    const couleur = COULEURS_POSTES.find(c => !postes.some(q => q.couleur === c)) ?? COULEURS_POSTES[0];
    const poste = { nom: `Poste ${++numero}`, p, couleur, marqueur: marqueur(couleur) };
    appliquerType(poste, type);
    postes.push(poste);
    choisirPoste(poste);
}
function appliquerType(poste, i) {
    const t = TYPES[i];
    poste.type = i;
    poste.optique = t.optique;
    poste.expo = t.expo;
    poste.site = t.site ? [...t.site] : null;
}
function supprimerPoste(poste) {
    postes.splice(postes.indexOf(poste), 1);
    oter(poste.marqueur);
    if (choisi === poste) {
        if (regard) sortirRegard();
        choisi = null;
        choisirPoste(postes[postes.length - 1] || null);
    } else majPostes();
    if (!postes.length) {
        effacerLigneDeVue();
        resultat.innerHTML = '';
        if (carte) choisirCarte(carte);
        note.textContent = NOTE_DEPART;
    } else if (carte) dessinerCarte();
}
function choisirPoste(poste) {
    choisi = poste;
    majPostes();
    if (!poste) return;
    selType.value = poste.type === 'libre' ? 'libre' : String(poste.type);
    champs.optique.value = poste.optique;
    champs.expo.value = poste.expo;
    champs.siteMin.value = poste.site ? poste.site[0] : '';
    champs.siteMax.value = poste.site ? poste.site[1] : '';
    const b = poste.p.bati;
    $('mi-ligne-etage').hidden = !b;
    if (b) {
        selEtage.length = 0;
        if (b.toit) selEtage.add(new Option('toit', 'toit'));
        else for (let e = 0; e < b.etages; e++) selEtage.add(new Option(e === 0 ? 'rez-de-chaussée' : e === 1 ? '1er étage' : `${e}e étage`, String(e)));
        selEtage.value = b.toit ? 'toit' : String(b.etage);
    }
    recalculer();
}
/** La liste des postes, en pastilles : un clic choisit, ✕ supprime. */
function majPostes() {
    listePostes.innerHTML = '';
    for (const poste of postes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'toggle' + (poste === choisi ? ' on' : '');
        b.innerHTML = `<i style="background:${hexa(poste.couleur)}"></i>${poste.nom}<b title="Supprimer">✕</b>`;
        b.addEventListener('click', e => {
            if (e.target.tagName === 'B') supprimerPoste(poste);
            else choisirPoste(poste);
        });
        listePostes.appendChild(b);
    }
    for (const b of [btnVues, btnVu, btnRegard, btnDeplacer]) b.disabled = !postes.length;
    btnPoser.disabled = postes.length >= MAX_POSTES;
    btnPoser.title = postes.length >= MAX_POSTES ? `${MAX_POSTES} postes au plus` : btnPoser.dataset.titre;
}
btnPoser.dataset.titre = btnPoser.title;

TYPES.forEach((t, i) => selType.add(new Option(`${t.nom} (≈)`, String(i))));
selType.add(new Option('Hauteurs saisies', 'libre'));
selType.addEventListener('change', () => {
    if (!choisi || selType.value === 'libre') return;
    appliquerType(choisi, Number(selType.value));
    choisirPoste(choisi);
});
for (const c of Object.values(champs)) c.addEventListener('change', () => {
    if (!choisi) return;
    choisi.type = 'libre';
    selType.value = 'libre';
    choisi.optique = Math.max(0, Number(champs.optique.value) || 0);
    choisi.expo = Math.max(0, Number(champs.expo.value) || 0);
    const lu = c => c.value.trim() === '' ? null : Number(c.value);
    const [a, b] = [lu(champs.siteMin), lu(champs.siteMax)];
    choisi.site = a == null && b == null ? null : [a ?? -90, b ?? 90];
    recalculer();
});
selEtage.addEventListener('change', () => {
    const b = choisi && choisi.p.bati;
    if (!b || b.toit) return;
    b.etage = Number(selEtage.value);
    choisi.p.base = b.etage * HAUTEUR_ETAGE;
    recalculer();
});
const lire = id => Math.max(0, Number($(id).value) || 0);
const enFace = () => ({ optique: lire('mi-optique-lui'), expo: lire('mi-expo-lui') });
const portee = () => Math.max(50, Number($('mi-portee').value) || 1500);
{
    const sel = $('mi-type-lui'), o = $('mi-optique-lui'), x = $('mi-expo-lui');
    TYPES.forEach((t, i) => sel.add(new Option(`${t.nom} (≈)`, String(i))));
    sel.add(new Option('Hauteurs saisies', 'libre'));
    const appliquer = () => { const t = TYPES[Number(sel.value)]; if (t) { o.value = t.optique; x.value = t.expo; } };
    sel.value = '3';
    appliquer();
    sel.addEventListener('change', () => { appliquer(); recalculer(); });
    for (const c of [o, x]) c.addEventListener('change', () => { sel.value = 'libre'; recalculer(); });
}
$('mi-portee').addEventListener('change', recalculer);
$('mi-cumul').addEventListener('change', () => { if (carte) dessinerCarte(); });

/** Le site, en degrés, sous lequel l'arme du poste voit le point visé. */
function siteVers(poste, de, vers) {
    return Math.atan2(vers.y - de.y, Math.hypot(vers.x - de.x, vers.z - de.z)) * 180 / Math.PI;
}
/** Un site en degrés, le millième (6 400 au tour) entre parenthèses. */
const siteTexte = d => `${signe(d, 1)}° (${signe(Math.round(d * 6400 / 360))} ‰)`;

// --- État et modes de clic ----------------------------------------------------------

let cible = null, mesureA = null, mesureB = null;
let modeClic = null;          // 'poser' | 'deplacer' | 'ldv' | 'mesurer' | null
let carte = null;             // 'vues' | 'vu' | null
const BOUTONS_MODE = { poser: btnPoser, deplacer: btnDeplacer, ldv: btnLdv, mesurer: btnMesurer };

/** La ligne de vue effacée : trait, point visé, profil et résultat. */
function effacerLigneDeVue() {
    cible = null;
    marqueurCible.visible = false;
    effacerTrait('ldv'); effacerTrait('ldv-masque');
    profil.hidden = true;
    if (choisi) resultat.innerHTML = lignePoint(choisi.nom.toLowerCase(), choisi.p);
}
const quandUnModeCommence = [];
/** `fn` est rappelée quand un mode de clic de la mission commence (le bréchage s'y coupe). */
const quandModeMission = fn => quandUnModeCommence.push(fn);
/** Coupe le mode de clic de la mission, s'il y en a un. */
function couperModeMission() { if (modeClic) choisirMode(modeClic); }
function choisirMode(m) {
    // Le bouton « Ligne de vue » décoché efface la ligne tracée.
    if (modeClic === 'ldv' && m === 'ldv' && !regard) effacerLigneDeVue();
    if (modeClic === 'mesurer' && m === 'mesurer') {
        mesureA = mesureB = null;
        marqueurA.visible = marqueurB.visible = false;
        effacerTrait('mesure');
    }
    modeClic = modeClic === m ? null : m;
    // Un seul mode de clic à la fois : celui du bréchage s'arrête.
    if (modeClic) for (const fn of quandUnModeCommence) fn();
    for (const [k, b] of Object.entries(BOUTONS_MODE)) b.classList.toggle('on', k === modeClic);
    renderer.domElement.style.cursor = modeClic ? 'crosshair' : '';
    if (modeClic === 'ldv' && !choisi) note.textContent = 'Pose d’abord un poste.';
    else if (modeClic === 'mesurer') note.textContent = 'Clique le point de départ, puis le point d’arrivée.';
    else if (modeClic) note.textContent = 'Clique sur le terrain, ou sur la façade ou le toit d’un bâtiment.';
}
btnPoser.addEventListener('click', () => choisirMode('poser'));
btnDeplacer.addEventListener('click', () => choisirMode('deplacer'));
btnLdv.addEventListener('click', () => choisirMode('ldv'));
btnMesurer.addEventListener('click', () => choisirMode('mesurer'));

prendreLeClic((e, souris) => {
    if (!modeClic && !regard) return false;
    const gene = empechement();
    if (gene) { note.textContent = gene; return true; }
    const p = pointSous(souris, modeClic !== 'mesurer');
    if (!p) { note.textContent = HORS_RELIEF; return true; }
    if (regard || modeClic === 'ldv') {
        if (!choisi) { note.textContent = 'Pose d’abord un poste.'; return true; }
        cible = p;
        afficherLigneDeVue();
    } else if (modeClic === 'poser' || modeClic === 'deplacer') {
        const deplacer = modeClic === 'deplacer';
        choisirMode(modeClic);          // le mode retombe après le clic
        if (deplacer && choisi) {
            choisi.p = p;
            if (p.bati && choisi.type !== 'libre' && TYPES[choisi.type].site) appliquerType(choisi, TYPE_FENETRE);
            choisirPoste(choisi);
        } else if (postes.length < MAX_POSTES) nouveauPoste(p);
    } else if (modeClic === 'mesurer') {
        if (!mesureA || mesureB) { mesureA = p; mesureB = null; }
        else mesureB = p;
        afficherMesure();
    }
    return true;
});

function afficherMesure() {
    placer(marqueurA, mesureA, 0.5);
    marqueurB.visible = !!mesureB;
    if (!mesureB) {
        effacerTrait('mesure');
        resultat.innerHTML = lignePoint('départ', mesureA);
        note.textContent = 'Clique le point d’arrivée.';
        return;
    }
    placer(marqueurB, mesureB, 0.5);
    tracer('mesure', drape(mesureA, mesureB, 96, 0.6), COULEUR_MESURE);
    profil.hidden = true;
    resultat.innerHTML = lignePoint('départ', mesureA) + lignePoint('arrivée', mesureB) + lignesMesure(mesureA, mesureB);
    note.textContent = 'Un clic de plus repart d’un nouveau point.';
}

/** Tout ce qui dépend des postes et des hauteurs, recalculé. */
function recalculer() {
    for (const poste of postes) placer(poste.marqueur, poste.p, poste.optique);
    if (regard && choisi) choisi.marqueur.visible = false;
    if (!choisi) return;
    if (cible) afficherLigneDeVue();
    else {
        resultat.innerHTML = lignePoint(choisi.nom.toLowerCase(), choisi.p);
        note.textContent = `${choisi.nom} posé. « Ligne de vue » puis un clic : ce qu’il voit de ce point.`;
    }
    if (carte) dessinerCarte();
    if (regard) appliquerRegard();
}

// --- Ligne de vue et profil -----------------------------------------------------------

function afficherLigneDeVue() {
    const poste = choisi, lui = enFace();
    if (!reliefPret([poste.p, cible], 50, () => { if (cible && choisi === poste) recalculer(); })) return;
    placer(marqueurCible, cible, lui.optique);
    // Je le vois : de mon optique à son point exposé. Il me voit : de son
    // optique à mon point exposé.
    const de = enHaut(poste.p, poste.optique), vers = enHaut(cible, lui.expo);
    const jeVois = premierObstacle(de, vers);
    const ilVoit = premierObstacle(enHaut(cible, lui.optique), enHaut(poste.p, poste.expo));
    if (jeVois) {
        tracer('ldv', [de, jeVois.point], VERT);
        tracer('ldv-masque', [jeVois.point, vers], ROUGE);
    } else {
        tracer('ldv', [de, vers], VERT);
        effacerTrait('ldv-masque');
    }
    const dit = (o, vu) => o ? `non, masqué par ${o.nature} à ${fmt(o.distance)} m` : vu;
    const site = siteVers(poste, de, vers);
    let traiter = '';
    if (poste.site && !jeVois) {
        const dedans = site >= poste.site[0] && site <= poste.site[1];
        traiter = ligneStat('je peux le traiter', dedans ? 'oui'
            : `non, site ${signe(site, 1)}° hors de ${signe(poste.site[0], 1)}° à ${signe(poste.site[1], 1)}°`, dedans ? 'vu' : 'hors');
    }
    resultat.innerHTML = lignePoint(poste.nom.toLowerCase(), poste.p) + lignePoint('point visé', cible) + lignesMesure(poste.p, cible)
        + ligneStat('site', siteTexte(site))
        + ligneStat('je le vois', dit(jeVois, 'oui'), jeVois ? 'masque' : 'vu') + traiter
        + ligneStat('il me voit', dit(ilVoit, 'oui'), ilVoit ? 'masque' : 'vu');
    const L = mesure(poste.p, cible).horizontale;
    note.textContent = L > portee()
        ? `Au-delà de la portée saisie (${fmt(portee())} m).`
        : 'Profil : le sol en gris, la ligne de visée en vert, rouge après l’obstacle.';
    dessinerProfil(de, vers, jeVois);
}

/** Le profil du sol du poste au point visé, et la ligne de visée de A à B. */
function dessinerProfil(A, B, obstacle) {
    profil.hidden = false;
    const ctx = profil.getContext('2d');
    const r = window.devicePixelRatio || 1;
    const W = profil.clientWidth || 300, H = profil.clientHeight || 110;
    profil.width = W * r; profil.height = H * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const N = 200, L = Math.hypot(B.x - A.x, B.z - A.z);
    const sol = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p = pointAuSol(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
        sol.push(p ? p.y : NaN);
    }
    const valeurs = sol.filter(Number.isFinite).concat([A.y, B.y]);
    let bas = Math.min(...valeurs), haut = Math.max(...valeurs);
    const marge = Math.max(2, (haut - bas) * 0.15);
    bas -= marge; haut += marge;
    const X = d => 8 + (W - 16) * d / Math.max(L, 1), Y = y => H - 16 - (H - 24) * (y - bas) / (haut - bas);
    ctx.fillStyle = 'rgba(160,160,160,.45)';
    ctx.beginPath();
    ctx.moveTo(X(0), H - 16);
    sol.forEach((y, i) => { if (Number.isFinite(y)) ctx.lineTo(X(L * i / N), Y(y)); });
    ctx.lineTo(X(L), H - 16);
    ctx.closePath();
    ctx.fill();
    const coupe = obstacle ? obstacle.distance / A.distanceTo(B) : 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4cc26b';
    ctx.beginPath(); ctx.moveTo(X(0), Y(A.y)); ctx.lineTo(X(L * coupe), Y(A.y + (B.y - A.y) * coupe)); ctx.stroke();
    if (obstacle) {
        ctx.strokeStyle = '#e5534b';
        ctx.beginPath(); ctx.moveTo(X(L * coupe), Y(A.y + (B.y - A.y) * coupe)); ctx.lineTo(X(L), Y(B.y)); ctx.stroke();
        ctx.fillStyle = '#e5534b';
        ctx.beginPath(); ctx.arc(X(L * coupe), Y(A.y + (B.y - A.y) * coupe), 3, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.fillStyle = '#9aa4ae';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${fmt(altitude(haut - marge))} m`, 4, 10);
    ctx.fillText(`${fmt(altitude(bas + marge))} m`, 4, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt(L)} m`, W - 4, H - 4);
}

// --- Carte des vues -------------------------------------------------------------------
// Six faces de 1 536 px par poste : 1 milliradian par pixel, 1 m à 1 km. Une
// grandeur flottante par pixel, 57 Mo de mémoire graphique par poste, 226 pour
// quatre. Le biais absorbe l'écart entre une surface et sa propre image dans
// la carte : 0,3 m plus 2 ‰ de la distance.
const TAILLE_CARTE = 1536;
const LOIN = 20000;
const COUCHE_CARTE = 7;
const cubes = [];             // une carte de distances et sa caméra par place
const matDistance = new THREE.ShaderMaterial({
    uniforms: { uO: { value: new THREE.Vector3() }, uLoin: { value: LOIN } },
    vertexShader: `varying vec3 vMonde;
void main() {
  vec4 p = vec4(position, 1.0);
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  vec4 m = modelMatrix * p;
  vMonde = m.xyz;
  gl_Position = projectionMatrix * viewMatrix * m;
}`,
    fragmentShader: `uniform vec3 uO;
uniform float uLoin;
varying vec3 vMonde;
void main() { gl_FragColor = vec4(distance(vMonde, uO) / uLoin, 0.0, 0.0, 1.0); }`,
    side: THREE.DoubleSide,
});

// Le calque : pour chaque poste (quatre places, déroulées : GLSL ES 3.0
// n'indexe pas un tableau d'échantillonneurs par une variable), vu ou non,
// dans la portée ou non, et dans le débattement de l'arme ou non.
const PLACES = [0, 1, 2, 3];
const uniformes = {
    uLoin: { value: LOIN }, uHauteur: { value: 1 }, uPortee: { value: 1500 }, uN: { value: 0 },
    uQuiMeVoit: { value: 0 }, uOpacite: { value: 1 },
};
for (const i of PLACES) {
    uniformes[`uD${i}`] = { value: null };
    uniformes[`uO${i}`] = { value: new THREE.Vector3() };
    uniformes[`uSite${i}`] = { value: new THREE.Vector2(-10, 10) };   // radians, sans limite
}
const matCarte = new THREE.ShaderMaterial({
    uniforms: uniformes,
    vertexShader: `varying vec3 vMonde;
void main() {
  vec4 m = modelMatrix * vec4(position, 1.0);
  vMonde = m.xyz;
  gl_Position = projectionMatrix * viewMatrix * m;
}`,
    fragmentShader: `uniform float uLoin, uHauteur, uPortee, uQuiMeVoit, uOpacite;
uniform int uN;
${PLACES.map(i => `uniform samplerCube uD${i};\nuniform vec3 uO${i};\nuniform vec2 uSite${i};`).join('\n')}
varying vec3 vMonde;
// 0 hors de portée, 1 masqué, 2 vu hors du débattement, 3 vu et dans le débattement.
float juger(samplerCube carte, vec3 O, vec2 site, vec3 p) {
  vec3 d = p - O;
  float r = length(d.xz);
  if (r > uPortee) return 0.0;
  float L = length(d);
  if (L > textureCube(carte, d).r * uLoin + 0.3 + 0.002 * L) return 1.0;
  float s = atan(d.y, r);
  return (s < site.x || s > site.y) ? 2.0 : 3.0;
}
void main() {
  vec3 p = vMonde + vec3(0.0, uHauteur, 0.0);
  float meilleur = 0.0;
  float bord = 0.0;
${PLACES.map(i => `  if (uN > ${i}) {
    meilleur = max(meilleur, juger(uD${i}, uO${i}, uSite${i}, p));
    float r${i} = length((p - uO${i}).xz);
    if (abs(r${i} - uPortee) < 2.0 * fwidth(r${i}) + 1.0) bord = 1.0;
  }`).join('\n')}
  if (meilleur == 0.0) discard;
  vec4 c;
  if (uQuiMeVoit > 0.5) c = meilleur >= 2.0 ? vec4(0.90, 0.20, 0.18, 0.50) : vec4(0.20, 0.75, 0.35, 0.18);
  else if (meilleur == 3.0) c = vec4(0.20, 0.80, 0.35, 0.42);
  else if (meilleur == 2.0) c = vec4(0.98, 0.60, 0.15, 0.50);
  else c = vec4(0.85, 0.20, 0.18, 0.30);
  if (uHauteur > 0.0 && bord > 0.5) c = vec4(1.0, 1.0, 1.0, 0.9);
  gl_FragColor = vec4(c.rgb, c.a * uOpacite);
}`,
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
});
// Sur les bâtiments, le point jugé est la façade ou le toit lui-même, sans
// hauteur ajoutée : une fenêtre, un toit d'où l'on voit, ou d'où l'on est vu.
// Mêmes uniformes, partagés, sauf la hauteur.
const matCarteBati = matCarte.clone();
matCarteBati.uniforms = { ...uniformes, uHauteur: { value: 0 } };
matCarteBati.side = THREE.DoubleSide;
// Sur le relief de calcul, au-delà de l'anneau, le calque passe devant
// l'horizon affiché, dont la finesse suit la caméra et qui le couvrirait par
// endroits de quelques mètres : décalé en profondeur, pas en hauteur, pour
// juger le même point.
const matCarteLoin = matCarte.clone();
matCarteLoin.uniforms = uniformes;
matCarteLoin.polygonOffsetUnits = -4000;
const calques = new THREE.Group();
calques.visible = false;
scene.add(calques);

/** Rend dans la place i la carte des distances depuis O, sur les obstacles affichés. */
function rendreDistances(i, O, objets) {
    if (!cubes[i]) {
        const cible = new THREE.WebGLCubeRenderTarget(TAILLE_CARTE, {
            type: THREE.FloatType, format: THREE.RedFormat, generateMipmaps: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        const cam = new THREE.CubeCamera(0.05, LOIN, cible);
        for (const c of cam.children) c.layers.set(COUCHE_CARTE);
        cubes[i] = { cible, cam };
    }
    const { cible, cam } = cubes[i];
    matDistance.uniforms.uO.value.copy(O);
    cam.position.copy(O);
    cam.updateMatrixWorld(true);
    cam.update(renderer, scene);
    return cible.texture;
}

function dessinerCarte() {
    const gene = empechement();
    if (gene) { note.textContent = gene; return; }
    const lui = enFace();
    const lesquels = ($('mi-cumul').checked ? postes : [choisi]).filter(Boolean).slice(0, PLACES.length);
    if (!reliefPret(lesquels.map(q => q.p), portee(), () => { if (carte) recalculer(); })) return;
    const objets = obstacles();
    for (const o of objets) o.layers.enable(COUCHE_CARTE);
    const avant = { fond: scene.background, matiere: scene.overrideMaterial, couleur: new THREE.Color(),
                    alpha: renderer.getClearAlpha(), ombres: renderer.shadowMap.autoUpdate };
    renderer.getClearColor(avant.couleur);
    scene.background = null;
    scene.overrideMaterial = matDistance;
    renderer.setClearColor(0xffffff, 1);          // rien dans cette direction : au plus loin
    renderer.shadowMap.autoUpdate = false;
    try {
        lesquels.forEach((poste, i) => {
            // Ce que je vois : de mon optique vers son point exposé ; qui me
            // voit : de mon point exposé vers son optique.
            const O = enHaut(poste.p, carte === 'vues' ? poste.optique : poste.expo);
            uniformes[`uD${i}`].value = rendreDistances(i, O, objets);
            uniformes[`uO${i}`].value.copy(O);
            const s = carte === 'vues' && poste.site;
            uniformes[`uSite${i}`].value.set(s ? s[0] * Math.PI / 180 : -10, s ? s[1] * Math.PI / 180 : 10);
        });
    } finally {
        scene.background = avant.fond;
        scene.overrideMaterial = avant.matiere;
        renderer.setClearColor(avant.couleur, avant.alpha);
        renderer.shadowMap.autoUpdate = avant.ombres;
        for (const o of objets) o.layers.disable(COUCHE_CARTE);
    }
    uniformes.uN.value = lesquels.length;
    uniformes.uHauteur.value = carte === 'vues' ? lui.expo : lui.optique;
    uniformes.uPortee.value = portee();
    uniformes.uQuiMeVoit.value = carte === 'vu' ? 1 : 0;
    calques.clear();
    const calquer = (s, materiau) => {
        const m = new THREE.Mesh(s.geometry, materiau);
        m.matrixAutoUpdate = false;
        s.updateMatrixWorld();
        m.matrix.copy(s.matrixWorld);
        m.renderOrder = 10;
        m.frustumCulled = false;
        calques.add(m);
    };
    for (const s of sols()) calquer(s, s === maillageCalcul() ? matCarteLoin : matCarte);
    for (const b of batis()) if (!b.isInstancedMesh) calquer(b, matCarteBati);
    calques.visible = true;
    legende.hidden = false;
    const qui = lesquels.length > 1 ? `${lesquels.length} postes` : lesquels[0].nom;
    const debattement = lesquels.some(q => q.site);
    legende.innerHTML = carte === 'vues'
        ? `Ce que voit ${qui}, cible à ${fmt(lui.expo, 1)} m :<i style="background:#33cc59"></i>`
          + (debattement ? 'vu et traitable<i style="background:#fa9926"></i>hors débattement' : 'vu')
          + '<i style="background:#d9332e"></i>masqué'
        : `Qui voit ${qui}, œil à ${fmt(lui.optique, 1)} m :<i style="background:#e6332e"></i>voit<i style="background:#33bf59"></i>ne voit pas`;
    note.textContent = `Calculé sur ${fmt(portee())} m autour de chaque poste, avec ce qui est affiché `
        + '(relief, bâtiments, végétation). À recalculer si tu masques ou rallumes une couche.';
}

const legende = document.createElement('div');
legende.id = 'mi-legende';
legende.hidden = true;
host.appendChild(legende);

function choisirCarte(c) {
    carte = carte === c || !postes.length ? null : c;
    btnVues.classList.toggle('on', carte === 'vues');
    btnVu.classList.toggle('on', carte === 'vu');
    if (carte) dessinerCarte();
    else { calques.visible = false; legende.hidden = true; }
}
btnVues.addEventListener('click', () => choisirCarte('vues'));
btnVu.addEventListener('click', () => choisirCarte('vu'));

// --- Vue depuis le poste ----------------------------------------------------------------
// La caméra à l'optique, qui tourne sur elle-même : OrbitControls tourne
// autour d'une cible, on le coupe donc, et on lui laisse une cible à 30 m
// dans l'axe (sa distance minimale est de 15 m). Son angle polaire maximal
// interdirait de regarder à l'horizontale : levé le temps de la vue.

let regard = null;            // { cap, site, avant }
const FOV_NU = 50;
const reticule = document.createElement('div');
reticule.id = 'mi-reticule';
reticule.hidden = true;
const hud = document.createElement('div');
hud.id = 'mi-hud';
hud.hidden = true;
host.append(reticule, hud);

function appliquerRegard() {
    const O = enHaut(choisi.p, choisi.optique);
    const c = Math.cos(regard.site);
    const dir = new THREE.Vector3(Math.sin(regard.cap) * c, Math.sin(regard.site), -Math.cos(regard.cap) * c);
    camera.position.copy(O);
    controls.target.copy(O).addScaledVector(dir, 30);
    camera.lookAt(controls.target);
    const grossissement = Math.tan(FOV_NU * Math.PI / 360) / Math.tan(camera.fov * Math.PI / 360);
    const site = regard.site * 180 / Math.PI;
    const hors = choisi.site && (site < choisi.site[0] || site > choisi.site[1]) ? ' (hors débattement)' : '';
    hud.textContent = `${choisi.nom} · Az ${fmt(Math.round(azimutMilliemes(Math.sin(regard.cap), Math.cos(regard.cap))) % 6400)} ‰`
        + ` · site ${siteTexte(site)}${hors} · ×${fmt(grossissement, 1)} · glisser pour tourner, molette pour grossir, Échap pour sortir`;
}
function entrerRegard() {
    if (droneActif) { note.textContent = 'Sors du drone d’abord.'; return; }
    if (orbite) arreterOrbite();
    const p = choisi.p;
    const vers = cible || { x: p.x + (controls.target.x - camera.position.x),
                            z: p.z + (controls.target.z - camera.position.z) };
    // Sans point visé, depuis une fenêtre, on regarde dehors.
    const dehors = !cible && p.bati && p.bati.dehors != null;
    regard = {
        cap: dehors ? p.bati.dehors : Math.atan2(vers.x - p.x, -(vers.z - p.z)), site: 0,
        avant: { position: camera.position.clone(), cible: controls.target.clone(), fov: camera.fov,
                 polaire: controls.maxPolarAngle },
    };
    controls.enabled = false;
    controls.maxPolarAngle = Math.PI;
    choisi.marqueur.visible = false;    // la caméra est dedans
    // À hauteur d'homme, le calque couvre presque tout le champ : pâli de
    // moitié, il laisse voir le sol et les façades dessous.
    uniformes.uOpacite.value = 0.5;
    camera.fov = FOV_NU;
    camera.updateProjectionMatrix();
    btnRegard.classList.add('on');
    reticule.hidden = hud.hidden = false;
    appliquerRegard();
}
function sortirRegard() {
    const a = regard.avant;
    regard = null;
    camera.position.copy(a.position);
    controls.target.copy(a.cible);
    camera.fov = a.fov;
    camera.updateProjectionMatrix();
    controls.maxPolarAngle = a.polaire;
    controls.enabled = true;
    for (const poste of postes) poste.marqueur.visible = true;
    uniformes.uOpacite.value = 1;
    btnRegard.classList.remove('on');
    reticule.hidden = hud.hidden = true;
}
btnRegard.addEventListener('click', () => { if (regard) sortirRegard(); else if (choisi) entrerRegard(); });
window.addEventListener('keydown', e => {
    if (regard && e.key === 'Escape') { e.preventDefault(); sortirRegard(); }
});
{
    let glisse = null;
    renderer.domElement.addEventListener('pointerdown', e => {
        if (regard) glisse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => { glisse = null; });
    renderer.domElement.addEventListener('pointermove', e => {
        if (!regard || !glisse) return;
        // Un pixel tourne d'autant moins que l'optique grossit.
        const k = 0.003 * camera.fov / FOV_NU;
        regard.cap -= (e.clientX - glisse.x) * k;
        regard.site = Math.min(Math.max(regard.site + (e.clientY - glisse.y) * k, -1.2), 1.2);
        glisse = { x: e.clientX, y: e.clientY };
        appliquerRegard();
    });
}
prendreLaMolette(e => {
    if (!regard) return false;
    const unite = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
    camera.fov = Math.min(Math.max(camera.fov * Math.exp(e.deltaY * unite * 0.0015), 2), FOV_NU);
    camera.updateProjectionMatrix();
    appliquerRegard();
    return true;
});

majPostes();
selType.value = String(TYPE_DEFAUT);
{
    const t = TYPES[TYPE_DEFAUT];
    champs.optique.value = t.optique; champs.expo.value = t.expo;
    champs.siteMin.value = t.site[0]; champs.siteMax.value = t.site[1];
}

/** L'état du module, pour les essais. */
export const etatMission = () => ({
    postes: postes.map(q => ({ nom: q.nom, p: q.p, optique: q.optique, expo: q.expo, site: q.site })),
    choisi: choisi && choisi.nom, cible, modeClic, carte, regard: !!regard,
});

// Pour le bréchage (interface/brechage.js), qui vient après et calcule sur
// les mêmes objets, avec les mêmes marqueurs et traits.
export { TYPES, mesure, altitudePoint, pointAuSol, solsVises, sols, obstacles, reliefPret, recaler, HORS_RELIEF, quandModeMission, couperModeMission, empechement, marqueur, placer, tracer, effacerTrait, drape, altitude, fmt };

// --- Pour l'audit des calculs (outils/audit-vues.mjs) ---------------------------------
// Les mêmes fonctions que la page, sur des paires données en (lon, lat, hauteur
// au-dessus du sol) : la ligne de vue (lancer de rayon) et la carte des vues
// (carte de distances cubique, jugée par le même calcul que le calque).

const versPoint = q => { const [x, y] = toLocal(q.lon, q.lat); return pointAuSol(x, -y); };

/** Pour chaque paire [A, B] : la ligne de vue de A (œil à A.h) vers B (B.h) passe-t-elle ? */
export async function ligneDeVueEssai(paires) {
    const pts = paires.flat().map(versPoint);
    await new Promise((ok, ko) => { if (reliefPret(pts, 50, ok)) ok(); setTimeout(() => ko(new Error('relief')), 60000); });
    return paires.map(([A, B]) => {
        const a = versPoint(A), b = versPoint(B);
        return !premierObstacle(enHaut(a, A.h), enHaut(b, B.h));
    });
}

/**
 * Pour un œil O et des cibles : vues ou non selon la carte de distances
 * cubique, jugées sur le processeur comme le nuanceur du calque (même biais).
 * La carte est relue face par face.
 */
export async function carteEssai(O, cibles) {
    const o = versPoint(O), pts = cibles.map(versPoint);
    await new Promise((ok, ko) => { if (reliefPret([o, ...pts], 50, ok)) ok(); setTimeout(() => ko(new Error('relief')), 60000); });
    const oeil = enHaut(versPoint(O), O.h);
    const objets = obstacles();
    for (const x of objets) x.layers.enable(COUCHE_CARTE);
    const avant = { fond: scene.background, matiere: scene.overrideMaterial, couleur: new THREE.Color(), alpha: renderer.getClearAlpha() };
    renderer.getClearColor(avant.couleur);
    scene.background = null; scene.overrideMaterial = matDistance;
    renderer.setClearColor(0xffffff, 1);
    try { rendreDistances(3, oeil, objets); } finally {
        scene.background = avant.fond; scene.overrideMaterial = avant.matiere;
        renderer.setClearColor(avant.couleur, avant.alpha);
        for (const x of objets) x.layers.disable(COUCHE_CARTE);
    }
    // Lecture par le GPU, comme le calque : un point par cible, dans une cible de n × 1.
    const n = cibles.length;
    const cible = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType });
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), rang = new Float32Array(n);
    cibles.forEach((c, i) => { const v = enHaut(versPoint(c), c.h); pos.set([v.x, v.y, v.z], i * 3); rang[i] = i; });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('rang', new THREE.BufferAttribute(rang, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: { uD: { value: cubes[3].cible.texture }, uO: { value: oeil }, uLoin: { value: LOIN }, uN: { value: n } },
        vertexShader: `attribute float rang; uniform float uN; varying vec3 vP;
void main() { vP = position; gl_PointSize = 1.0; gl_Position = vec4((rang + 0.5) / uN * 2.0 - 1.0, 0.0, 0.0, 1.0); }`,
        fragmentShader: `uniform samplerCube uD; uniform vec3 uO; uniform float uLoin; varying vec3 vP;
void main() { vec3 d = vP - uO; float L = length(d);
  gl_FragColor = vec4(L > textureCube(uD, d).r * uLoin + 0.3 + 0.002 * L ? 0.0 : 1.0, 0.0, 0.0, 1.0); }`,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;      // ses positions sont du monde, pas de l'écran
    const sc = new THREE.Scene(); sc.add(points);
    const lu = new Float32Array(n * 4);
    const avantCible = renderer.getRenderTarget();
    renderer.setRenderTarget(cible);
    renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.render(sc, new THREE.Camera());
    renderer.readRenderTargetPixels(cible, 0, 0, n, 1, lu);
    renderer.setRenderTarget(avantCible);
    renderer.setClearColor(avant.couleur, avant.alpha);
    cible.dispose(); geo.dispose(); mat.dispose();
    return cibles.map((_, i) => lu[i * 4] > 0.5);
}
