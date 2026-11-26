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
    trajectoire, pointDeChute, allongement, ecartType,
} from '../../commun/tir.js';

const $ = id => document.getElementById(id);
const selArme = $('tir-arme'), btnPiece = $('tir-piece'), btnObjectif = $('tir-objectif');
const selTrajectoire = $('tir-trajectoire'), caseRelief = $('tir-relief'), btnAngles = $('tir-angles');
const profil = $('tir-profil');
const champEpP = $('tir-ep-p'), champEpD = $('tir-ep-d'), selNombre = $('tir-nombre');
const btnTirer = $('tir-tirer'), btnEffacer = $('tir-effacer');
const resultat = $('tir-resultat'), note = $('tir-note');
const NOTE_DEPART = note.textContent;

const COULEUR_PIECE = 0x2f80ed, COULEUR_OBJECTIF = 0xe5534b;
const COULEUR_MASQUE = 0xe5534b, COULEUR_TRAJET = 0xbfe3ff;
const COULEUR_COUP = 0xf2994a, COULEUR_ELLIPSE = 0xf2c94c, COULEUR_CADRE = 0xffffff;
const marqueurPiece = marqueur(COULEUR_PIECE), marqueurObjectif = marqueur(COULEUR_OBJECTIF);

let mode = null;             // 'piece' | 'objectif' | null
let piece = null, objectif = null;
let salve = 0;               // numéro de la salve : sa graine
let coups = null;            // la dernière salve : écarts { portee, direction }

ARMES.forEach((a, i) => selArme.add(new Option(a.nom, String(i))));
const arme = () => ARMES[Number(selArme.value)];
const NOMS_TRAJECTOIRE = { courbe: 'courbe (tombe raide)', tendue: 'tendue (tombe à plat)' };
/** Les trajectoires possibles de l'arme, dans la liste ; la courbe par défaut. */
function majTrajectoires() {
    selTrajectoire.innerHTML = '';
    for (const [k, w] of Object.entries(arme().chutes)) selTrajectoire.add(new Option(`${NOMS_TRAJECTOIRE[k]} · ${w}°`, k));
    selTrajectoire.value = 'courbe';
    selTrajectoire.disabled = selTrajectoire.options.length < 2;
}
majTrajectoires();
const angleChute = () => arme().chutes[selTrajectoire.value];

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
    oterAnglesMorts();
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
selArme.addEventListener('change', () => { oterSalve(); oterAnglesMorts(); majTrajectoires(); regler(); });
selTrajectoire.addEventListener('change', () => { oterAnglesMorts(); if (coups) tirer(false); else afficher(); });
caseRelief.addEventListener('change', () => { if (coups) tirer(false); });
for (const c of [champEpP, champEpD]) c.addEventListener('change', () => { oterSalve(); afficher(); });
selNombre.addEventListener('change', () => { if (coups) tirer(); });

function majBoutons() {
    const g = geometrie();
    btnTirer.disabled = !g || !!horsDePortee(arme(), g.horizontale);
    btnEffacer.disabled = !piece && !objectif;
    btnAngles.disabled = btnTirer.disabled;
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
const matMasque = matCoup.clone();
matMasque.color.set(COULEUR_MASQUE);
let nuages = [];
let chutes = null;           // où chaque coup de la salve a touché le sol

function oterSalve() {
    coups = chutes = null;
    for (const n of nuages) { groupe.remove(n); n.geometry.dispose(); }
    nuages = [];
    for (const n of ['tir-ellipse', 'tir-cadre', 'tir-bande-1', 'tir-bande-2', 'tir-trajet']) effacerTrait(n);
    profil.hidden = true;
}

/**
 * Où tombe un coup visé à l'écart (portée, direction) de l'objectif. Sur
 * « sol plat » (relief décoché), à la verticale du point visé : c'est la
 * dispersion telle qu'on la dessine sur une carte. Sinon, la trajectoire
 * stylisée du coup est suivie jusqu'au sol vrai : { p (Vector3), masque,
 * le long (m, dans l'axe, depuis l'objectif) } ou null hors du relief chargé.
 */
function chuteDe(c, az, dh, relief = caseRelief.checked) {
    const { dx, dz } = versScene(c.portee, c.direction, az);
    const ax = objectif.x + dx, az2 = objectif.z + dz;
    if (!relief) {
        const q = pointAuSol(ax, az2);
        return q && { p: new THREE.Vector3(q.x, q.y + dh, q.z), masque: false, le: c.portee };
    }
    const D = Math.hypot(ax - piece.x, az2 - piece.z);
    const ux = (ax - piece.x) / D, uz = (az2 - piece.z) / D;
    const sol = s => { const q = pointAuSol(piece.x + ux * s, piece.z + uz * s); return q && q.y - piece.y; };
    const r = pointDeChute(D, objectif.y - piece.y, angleChute(), sol, Math.max(2, D / 400));
    if (!r) return null;
    const x = piece.x + ux * r.s, z = piece.z + uz * r.s;
    // Le long de l'axe du tir, depuis l'objectif : la portée du point touché.
    const le = (x - objectif.x) * Math.sin(az) - (z - objectif.z) * Math.cos(az);
    // Tombé avant le rectangle de ±4 EP : arrêté par une crête en chemin.
    return { p: new THREE.Vector3(x, piece.y + r.h + dh, z), masque: D - r.s > 4 * lireEp(champEpP) + 25, le };
}
/** Une ligne d'écarts (portée, direction), posée là où elle tombe, tracée sous ce nom. */
function tracerAuSol(nom, ecarts, az, couleur) {
    tracer(nom, ecarts.map(c => chuteDe(c, az, 0.6)).filter(r => r && !r.masque).map(r => r.p), couleur);
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

/** La trajectoire du coup moyen, tracée dans l'air de la pièce à l'objectif. */
function tracerTrajet() {
    const D = Math.hypot(objectif.x - piece.x, objectif.z - piece.z);
    const h = trajectoire(D, objectif.y - piece.y, angleChute()), pts = [];
    for (let i = 0; i <= 96; i++) {
        const t = i / 96;
        pts.push(new THREE.Vector3(piece.x + (objectif.x - piece.x) * t, piece.y + h(D * t), piece.z + (objectif.z - piece.z) * t));
    }
    tracer('tir-trajet', pts, COULEUR_TRAJET);
}

/** Tire une salve ; `nouvelle` faux rejoue la dernière (même graine), pour comparer. */
function tirer(nouvelle = true) {
    const g = geometrie();
    if (!g) return;
    const raison = horsDePortee(arme(), g.horizontale);
    if (raison) { note.textContent = `Objectif ${raison}.`; return; }
    const epP = lireEp(champEpP), epD = lireEp(champEpD);
    // Le relief de calcul doit couvrir le trajet et la zone de chute.
    if (!reliefPret([piece, objectif], 5 * Math.max(epP, epD) + 100, () => tirer(nouvelle), note)) return;
    oterSalve();
    if (nouvelle || !salve) salve++;
    const n = Number(selNombre.value);
    coups = tirerCoups(n, epP, epD, salve);
    const az = azimutScene();
    chutes = coups.map(c => chuteDe(c, az, 0.4));
    for (const [masque, mat] of [[false, matCoup], [true, matMasque]]) {
        const pts = chutes.filter(r => r && r.masque === masque).map(r => r.p);
        if (!pts.length) continue;
        const nuage = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), mat);
        nuage.renderOrder = 20;           // sous l'ellipse et le rectangle (21)
        groupe.add(nuage);
        nuages.push(nuage);
    }
    tracerTrajet();
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
btnTirer.addEventListener('click', () => tirer());

function effacer() {
    oterSalve();
    piece = objectif = null;
    marqueurPiece.visible = marqueurObjectif.visible = false;
    effacerTrait('tir-axe');
    oterAnglesMorts();
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
        if (caseRelief.checked && chutes) h += lignesRelief(epP);
    }
    h += `<div class="tir-explique">${pastille(COULEUR_COUP)}Chaque point est un coup, tiré avec les mêmes éléments.
        L’ellipse jaune contient en moyenne <b>la moitié</b> des coups, le rectangle blanc <b>presque tous</b> (99 %).
        Elle est allongée dans l’axe du tir : on se trompe plus en portée qu’en direction.
        Avec peu de coups, le compte s’écarte de 50 % ; avec 500, il s’en approche.</div>`
        + `<div class="tir-explique">${arme().source}</div>`;
    resultat.innerHTML = h;
}

/** La pente du sol au point visé, dans l'axe du tir, en degrés : positive en contre-pente. */
function penteAuPointVise(L) {
    const az = azimutScene(), ux = Math.sin(az), uz = -Math.cos(az);
    const avant = pointAuSol(objectif.x - ux * L, objectif.z - uz * L), apres = pointAuSol(objectif.x + ux * L, objectif.z + uz * L);
    return avant && apres ? Math.atan((avant.y - apres.y) / (2 * L)) * 180 / Math.PI : null;
}

/** Ce que le relief fait à la salve : pente, allongement, coups arrêtés ; et le profil. */
function lignesRelief(epP) {
    const w = angleChute();
    const alpha = penteAuPointVise(Math.max(10, 2 * epP));
    const touches = chutes.map((r, i) => [r, coups[i]]).filter(([r]) => r && !r.masque);
    const masques = chutes.filter(r => r && r.masque).length;
    const mesure = touches.length > 5 ? ecartType(touches.map(([r]) => r.le)) / ecartType(touches.map(([, c]) => c.portee)) : null;
    const k = alpha == null ? undefined : allongement(w, alpha);
    let h = '';
    if (alpha != null) {
        const sens = Math.abs(alpha) < 1 ? 'presque plat' : alpha > 0 ? 'contre-pente' : 'pente face à la pièce';
        h += ligne('sol au point visé', `${sens} · ${fmt(Math.abs(alpha))}°`);
        h += ligne('angle de chute', `${w}°`);
        if (mesure != null) h += ligne('longueur de la zone de chute', `×${fmt(mesure, 2)} (sol plat : ×1)`);
    }
    if (masques) h += ligne(`${pastille(COULEUR_MASQUE)}arrêtés par le relief`, `${masques} / ${coups.length}`);
    let texte;
    if (alpha == null) texte = '';
    else if (k === null) texte = `Le versant (${fmt(alpha)}°) est plus raide que la chute (${w}°) : les coups passent au-dessus sans pouvoir le toucher. C’est un <b>angle mort</b>.`;
    else if (alpha > 1) texte = `Contre-pente : le sol s’éloigne sous les coups, ils glissent plus loin. La zone de chute s’<b>allonge</b> (×${fmt(k, 2)} par la règle tan ${w}° / (tan ${w}° − tan ${fmt(alpha)}°)). Plus la chute est raide, moins elle s’allonge.`;
    else if (alpha < -1) texte = `Pente face à la pièce : le sol vient au-devant des coups, ils tombent plus tôt. La zone de chute <b>raccourcit</b> (×${fmt(k, 2)}).`;
    else texte = 'Sol presque plat : la zone de chute garde sa longueur. Vise une pente pour voir la différence.';
    if (masques) texte += ` ${masques > 1 ? 'Les coups rouges sont arrêtés' : 'Le coup rouge est arrêté'} par une crête avant d’arriver.`;
    if (texte) h += `<div class="tir-explique">${texte}</div>`;
    dessinerProfil();
    return h;
}

/** Le profil du tir : le sol de la pièce à un peu au-delà de l'objectif, et la trajectoire du coup moyen. */
function dessinerProfil() {
    const D = Math.hypot(objectif.x - piece.x, objectif.z - piece.z);
    const ux = (objectif.x - piece.x) / D, uz = (objectif.z - piece.z) / D, fin = D * 1.15;
    const h = trajectoire(D, objectif.y - piece.y, angleChute());
    const sol = [], vol = [];
    for (let i = 0; i <= 160; i++) {
        const sv = fin * i / 160, q = pointAuSol(piece.x + ux * sv, piece.z + uz * sv);
        if (q) sol.push([sv, q.y - piece.y]);
    }
    const chute = pointDeChute(D, objectif.y - piece.y, angleChute(),
        sv => { const q = pointAuSol(piece.x + ux * sv, piece.z + uz * sv); return q && q.y - piece.y; }, Math.max(2, D / 400));
    const bout = chute ? chute.s : D;
    for (let i = 0; i <= 160; i++) { const sv = bout * i / 160; vol.push([sv, h(sv)]); }
    const ys = sol.concat(vol).map(v => v[1]);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const c = profil.getContext('2d'), W = profil.width, H = profil.height, m = 6;
    const X = sv => m + (W - 2 * m) * sv / fin, Y = y => H - m - (H - 2 * m) * (y - y0) / ((y1 - y0) || 1);
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(140,120,90,.55)';
    c.beginPath(); c.moveTo(X(sol[0][0]), H);
    for (const [sv, y] of sol) c.lineTo(X(sv), Y(y));
    c.lineTo(X(sol[sol.length - 1][0]), H); c.closePath(); c.fill();
    c.strokeStyle = '#bfe3ff'; c.lineWidth = 1.5;
    c.beginPath(); vol.forEach(([sv, y], i) => (i ? c.lineTo(X(sv), Y(y)) : c.moveTo(X(sv), Y(y)))); c.stroke();
    c.fillStyle = '#e5534b'; c.beginPath(); c.arc(X(D), Y(objectif.y - piece.y), 3, 0, 2 * Math.PI); c.fill();
    c.fillStyle = '#9aa0a6'; c.font = '10px sans-serif';
    c.fillText('pièce', m, 12); c.fillText('objectif', Math.min(X(D) - 18, W - 44), 12);
    profil.hidden = false;
}

// --- Les angles morts ------------------------------------------------------------------
// Autour de l'objectif, chaque case est-elle atteinte par la trajectoire du
// coup moyen qui y est visée, ou une crête (ou le versant lui-même, plus
// raide que la chute) l'en empêche-t-elle ? Les cases non battues en rouge.

const CASES_ANGLES = 40;
const matAngles = new THREE.MeshBasicMaterial({ color: COULEUR_MASQUE, transparent: true, opacity: 0.42,
                                                depthWrite: false, side: THREE.DoubleSide });
let calqueAngles = null;
function oterAnglesMorts() {
    if (calqueAngles) { groupe.remove(calqueAngles); calqueAngles.geometry.dispose(); calqueAngles = null; }
    btnAngles.classList.remove('on');
}
function calculerAnglesMorts() {
    const g = geometrie();
    if (!g) return;
    const R = Math.min(1500, Math.max(200, 0.3 * g.horizontale));
    if (!reliefPret([piece, objectif], R + 100, calculerAnglesMorts, note)) return;
    oterAnglesMorts();
    const w = angleChute(), pas = 2 * R / CASES_ANGLES, pos = [], index = [];
    let vues = 0, cachees = 0;
    for (let i = 0; i < CASES_ANGLES; i++) {
        for (let j = 0; j < CASES_ANGLES; j++) {
            const x = objectif.x - R + (i + 0.5) * pas, z = objectif.z - R + (j + 0.5) * pas;
            const q = pointAuSol(x, z);
            if (!q) continue;
            const D = Math.hypot(x - piece.x, z - piece.z);
            if (horsDePortee(arme(), D)) continue;
            const ux = (x - piece.x) / D, uz = (z - piece.z) / D;
            const r = pointDeChute(D, q.y - piece.y, w,
                sv => { const t = pointAuSol(piece.x + ux * sv, piece.z + uz * sv); return t && t.y - piece.y; }, Math.max(2, D / 300));
            if (!r) continue;
            if (D - r.s <= Math.max(8, pas / 2)) { vues++; continue; }
            cachees++;
            const k = pos.length / 3;
            for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                const c = pointAuSol(x + dx * pas / 2, z + dz * pas / 2) || q;
                pos.push(c.x, c.y + 0.8, c.z);
            }
            index.push(k, k + 1, k + 2, k, k + 2, k + 3);
        }
    }
    if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(index);
        calqueAngles = new THREE.Mesh(geo, matAngles);
        calqueAngles.renderOrder = 19;
        groupe.add(calqueAngles);
    }
    btnAngles.classList.add('on');
    const total = vues + cachees;
    note.textContent = total ? `Angles morts, trajectoire ${selTrajectoire.value} : ${fmt(100 * cachees / total)} % du carré de ${fmt(2 * R)} m autour de l’objectif ne peut pas être battu (en rouge). Change de trajectoire ou déplace la pièce pour comparer.`
        : 'Aucune case calculable : relief absent autour de l’objectif.';
}
btnAngles.addEventListener('click', () => {
    if (calqueAngles) { oterAnglesMorts(); return; }
    note.textContent = 'Calcul des angles morts…';
    setTimeout(calculerAnglesMorts, 30);
});

/** L'état du module, pour les essais. */
export const etatTir = () => ({ piece, objectif, mode, salve, coups: coups && coups.length, arme: arme().id,
    masques: chutes ? chutes.filter(r => r && r.masque).length : 0, anglesMorts: !!calqueAngles });
