// Tir indirect, pour l'instruction : une pièce et un objectif posés sur le
// terrain, une salve tirée au hasard autour de l'objectif, et ce qu'il faut
// en retenir dessiné au sol : l'ellipse qui contient la moitié des coups, et
// le rectangle de ±4 écarts probables qui les contient presque tous. Le
// public visé est débutant : peu de chiffres, des couleurs, une phrase.
//
// Le calcul (lois, graines, axes) est dans js/commun/tir.js, vérifié sous Node
// par outils/verifier-tir.mjs. Aucune table de tir : des écarts probables
// d'école, que la page dit tels et laisse régler.

import * as THREE from 'three';
import { scene, camera, renderer } from '../socle/rendu.js';
import { prendreLeClic } from './gestes.js';
import {
    mesure, pointAuSol, solsVises, reliefPret, recaler, HORS_RELIEF,
    quandModeMission, couperModeMission, empechement, marqueur, placer, tracer, effacerTrait, drape, fmt,
} from './mission.js';
import { couperModeBrechage } from './brechage.js';
import {
    ARMES, ELLIPSE_50_EN_EP, epDecole, horsDePortee, tirerCoups, dansEllipse50, versScene, contourEllipse,
} from '../../commun/tir.js';

const $ = id => document.getElementById(id);
const selArme = $('tir-arme'), btnPiece = $('tir-piece'), btnObjectif = $('tir-objectif');
const champEpP = $('tir-ep-p'), champEpD = $('tir-ep-d'), selNombre = $('tir-nombre');
const btnTirer = $('tir-tirer'), btnEffacer = $('tir-effacer');
const resultat = $('tir-resultat'), note = $('tir-note');
const NOTE_DEPART = note.textContent;

const COULEUR_PIECE = 0x2f80ed, COULEUR_OBJECTIF = 0xe5534b;
const COULEUR_COUP = 0xf2994a, COULEUR_ELLIPSE = 0xf2c94c, COULEUR_CADRE = 0xffffff;
const marqueurPiece = marqueur(COULEUR_PIECE), marqueurObjectif = marqueur(COULEUR_OBJECTIF);

let mode = null;             // 'piece' | 'objectif' | null
let piece = null, objectif = null;
let salve = 0;               // numéro de la salve : sa graine
let coups = null;            // la dernière salve : écarts { portee, direction }

ARMES.forEach((a, i) => selArme.add(new Option(a.nom, String(i))));
const arme = () => ARMES[Number(selArme.value)];

// --- Les clics -------------------------------------------------------------------------

function choisirMode(m) {
    mode = mode === m ? null : m;
    // Un seul mode de clic à la fois sur la page.
    if (mode) { couperModeMission(); couperModeBrechage(); }
    btnPiece.classList.toggle('on', mode === 'piece');
    btnObjectif.classList.toggle('on', mode === 'objectif');
    renderer.domElement.style.cursor = mode ? 'crosshair' : '';
    if (mode === 'piece') note.textContent = 'Clique sur le terrain là où se trouve la pièce.';
    else if (mode === 'objectif') note.textContent = 'Clique sur le terrain le point à battre.';
}
quandModeMission(() => { if (mode) choisirMode(mode); });
btnPiece.addEventListener('click', () => choisirMode('piece'));
btnObjectif.addEventListener('click', () => choisirMode('objectif'));

const rayon = new THREE.Raycaster();
prendreLeClic((e, souris) => {
    if (!mode) return false;
    const gene = empechement();
    if (gene) { note.textContent = gene; return true; }
    rayon.setFromCamera(souris, camera);
    const t = rayon.intersectObjects(solsVises(), false)[0];
    const p = t && pointAuSol(t.point.x, t.point.z);
    if (!p) { note.textContent = HORS_RELIEF; return true; }
    if (mode === 'piece') { piece = p; placer(marqueurPiece, p, 2); }
    else { objectif = p; placer(marqueurObjectif, p, 2); }
    choisirMode(mode);           // le mode retombe après le clic
    oterSalve();
    regler();
    note.textContent = !objectif ? 'Pièce posée. Pose maintenant l’objectif.'
        : !piece ? 'Objectif posé. Pose maintenant la pièce.'
        : btnTirer.disabled ? 'Objectif hors de portée (voir ci-dessous) : déplace-le, ou change d’arme.'
        : 'Tout est posé : choisis le nombre de coups, puis « Tirer ».';
    return true;
});

// --- Réglages --------------------------------------------------------------------------

/** La distance et l'azimut de la pièce à l'objectif, ou null. */
const geometrie = () => (piece && objectif ? mesure(piece, objectif) : null);

/** Les EP d'école de l'arme à cette distance, remis dans les champs ; l'état des boutons. */
function regler() {
    const g = geometrie();
    if (g) {
        const ep = epDecole(arme(), g.horizontale);
        champEpP.value = ep.portee; champEpD.value = ep.direction;
    }
    majBoutons();
    afficher();
}
selArme.addEventListener('change', () => { oterSalve(); regler(); });
for (const c of [champEpP, champEpD]) c.addEventListener('change', () => { oterSalve(); afficher(); });
selNombre.addEventListener('change', () => { if (coups) tirer(); });

function majBoutons() {
    const g = geometrie();
    btnTirer.disabled = !g || !!horsDePortee(arme(), g.horizontale);
    btnEffacer.disabled = !piece && !objectif;
}

const lireEp = c => Math.max(1, Number(c.value) || 1);

// --- La salve --------------------------------------------------------------------------

const groupe = new THREE.Group();
scene.add(groupe);
// Des points ronds : un disque dessiné une fois, en texture (les points de
// three.js sont carrés sans elle).
function disque() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(16, 16, 14, 0, 2 * Math.PI); g.fill();
    return new THREE.CanvasTexture(c);
}
const matCoup = new THREE.PointsMaterial({ color: COULEUR_COUP, size: 8, sizeAttenuation: false, depthTest: false,
                                           transparent: true, map: disque(), alphaTest: 0.5 });
let nuage = null;

function oterSalve() {
    coups = null;
    if (nuage) { groupe.remove(nuage); nuage.geometry.dispose(); nuage = null; }
    for (const n of ['tir-ellipse', 'tir-cadre', 'tir-bande-1', 'tir-bande-2']) effacerTrait(n);
}

/** Un écart (portée, direction) autour de l'objectif, posé sur le sol : Vector3 ou null. */
function auSol(c, az, dh) {
    const { dx, dz } = versScene(c.portee, c.direction, az);
    const p = pointAuSol(objectif.x + dx, objectif.z + dz);
    return p ? new THREE.Vector3(p.x, p.y + dh, p.z) : null;
}
/** Une ligne d'écarts (portée, direction), drapée sur le sol, tracée sous ce nom. */
function tracerAuSol(nom, ecarts, az, couleur) {
    tracer(nom, ecarts.map(c => auSol(c, az, 0.6)).filter(Boolean), couleur);
}
/** Les écarts d'un segment, tous les quelques mètres, pour qu'il épouse le relief. */
function segment(a, b, n = 24) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push({ portee: a.portee + (b.portee - a.portee) * t, direction: a.direction + (b.direction - a.direction) * t });
    }
    return pts;
}

/** L'azimut de tir dans la scène, en radians depuis le nord (x à l'est, z au sud). */
const azimutScene = () => Math.atan2(objectif.x - piece.x, -(objectif.z - piece.z));

function tirer() {
    const g = geometrie();
    if (!g) return;
    const raison = horsDePortee(arme(), g.horizontale);
    if (raison) { note.textContent = `Objectif ${raison}.`; return; }
    const epP = lireEp(champEpP), epD = lireEp(champEpD);
    // Le relief de calcul doit couvrir la zone de chute (±4 EP et un peu plus).
    if (!reliefPret([objectif], 5 * Math.max(epP, epD) + 50, () => { recaler(objectif); tirer(); }, note)) return;
    oterSalve();
    salve++;
    const n = Number(selNombre.value);
    coups = tirerCoups(n, epP, epD, salve);
    const az = azimutScene();
    const pts = coups.map(c => auSol(c, az, 0.4)).filter(Boolean);
    nuage = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), matCoup);
    nuage.renderOrder = 20;           // sous l'ellipse et le rectangle (21)
    groupe.add(nuage);
    // L'ellipse de la moitié des coups ; le rectangle de ±4 EP (presque tous) ;
    // la bande centrale de ±1 EP en portée (la moitié, dans l'axe du tir).
    tracerAuSol('tir-ellipse', contourEllipse(ELLIPSE_50_EN_EP * epP, ELLIPSE_50_EN_EP * epD), az, COULEUR_ELLIPSE);
    const P = 4 * epP, D = 4 * epD;
    tracerAuSol('tir-cadre', [
        ...segment({ portee: -P, direction: -D }, { portee: P, direction: -D }),
        ...segment({ portee: P, direction: -D }, { portee: P, direction: D }),
        ...segment({ portee: P, direction: D }, { portee: -P, direction: D }),
        ...segment({ portee: -P, direction: D }, { portee: -P, direction: -D }),
    ], az, COULEUR_CADRE);
    tracerAuSol('tir-bande-1', segment({ portee: epP, direction: -D }, { portee: epP, direction: D }), az, COULEUR_CADRE);
    tracerAuSol('tir-bande-2', segment({ portee: -epP, direction: -D }, { portee: -epP, direction: D }), az, COULEUR_CADRE);
    note.textContent = `Salve n° ${salve}. Tire encore : les coups changent, la forme reste.`;
    afficher();
}
btnTirer.addEventListener('click', tirer);

function effacer() {
    oterSalve();
    piece = objectif = null;
    marqueurPiece.visible = marqueurObjectif.visible = false;
    effacerTrait('tir-axe');
    if (mode) choisirMode(mode);
    majBoutons();
    resultat.innerHTML = '';
    note.textContent = NOTE_DEPART;
}
btnEffacer.addEventListener('click', effacer);

// --- Ce que la page en dit -------------------------------------------------------------

const ligne = (nom, valeur) => `<div class="stat"><span>${nom}</span><b>${valeur}</b></div>`;
const pastille = (couleur, trait = false) => `<i class="${trait ? 'trait' : ''}" style="background:#${couleur.toString(16).padStart(6, '0')}"></i>`;
const pc = (k, n) => `${fmt(100 * k / n)} %`;

function afficher() {
    const g = geometrie();
    if (piece && objectif) tracer('tir-axe', drape(piece, objectif, 64, 1), COULEUR_PIECE);
    if (!g) { resultat.innerHTML = ''; return; }
    const raison = horsDePortee(arme(), g.horizontale);
    let h = ligne('distance', `${fmt(g.horizontale)} m`)
        + ligne('azimut', `${fmt(Math.round(g.milliemes) % 6400)} ‰ · ${fmt((Math.round(g.degres * 10) / 10) % 360, 1)}°`);
    if (raison) {
        resultat.innerHTML = h + `<div class="tir-explique">Objectif ${raison}.</div>`;
        return;
    }
    const epP = lireEp(champEpP), epD = lireEp(champEpD);
    h += ligne('écart probable', `${fmt(epP)} m en portée · ${fmt(epD)} m en direction`);
    if (coups) {
        const n = coups.length;
        const dans = coups.filter(c => dansEllipse50(c, epP, epD)).length;
        const bande = coups.filter(c => Math.abs(c.portee) <= epP).length;
        const cadre = coups.filter(c => Math.abs(c.portee) <= 4 * epP && Math.abs(c.direction) <= 4 * epD).length;
        h += ligne(`${pastille(COULEUR_ELLIPSE, true)}dans l’ellipse`, `${dans} / ${n} (${pc(dans, n)})`)
            + ligne('entre les deux traits du milieu', `${bande} / ${n} (${pc(bande, n)})`)
            + ligne(`${pastille(COULEUR_CADRE, true)}dans le rectangle`, `${cadre} / ${n} (${pc(cadre, n)})`);
    }
    h += `<div class="tir-explique">${pastille(COULEUR_COUP)}Chaque point est un coup, tiré avec les mêmes éléments.
        L’ellipse jaune contient en moyenne <b>la moitié</b> des coups, le rectangle blanc <b>presque tous</b> (99 %).
        Elle est allongée dans l’axe du tir : on se trompe plus en portée qu’en direction.
        Avec peu de coups, le compte s’écarte de 50 % ; avec 500, il s’en approche.</div>`
        + `<div class="tir-explique">${arme().source}</div>`;
    resultat.innerHTML = h;
}

/** L'état du module, pour les essais. */
export const etatTir = () => ({ piece, objectif, mode, salve, coups: coups && coups.length, arme: arme().id });
