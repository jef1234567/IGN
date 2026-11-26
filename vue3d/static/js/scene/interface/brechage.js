// Bréchage : un obstacle tracé sur le terrain (barbelés, champ de mines,
// merlon, seuls ou ensemble), le côté d'où vient l'attaquant, puis les
// meilleures positions pour le défenseur (voir l'obstacle, rester caché des
// abords) et pour l'appui de l'attaquant (voir l'obstacle dans le débattement
// de son arme, et les positions du défenseur).
//
// Les cartes de vues de la préparation de mission jugent un poste ; ici il
// faut en juger des milliers. Le dessus de ce qui est affiché (relief,
// bâtiments, végétation) est donc rendu une fois, vu d'en haut, dans une
// grille de hauteurs ; chaque ligne de vue y est ensuite suivie pas à pas, sur
// le processeur. Une grille de 2 048 cases donne 1,6 m par case pour un
// obstacle de 200 m cherché à 1 500 m : un mur plus mince qu'une case peut y
// manquer, un arbre isolé y masque comme un mur. Ordres de grandeur, à
// vérifier à la ligne de vue du poste.

import * as THREE from 'three';
import { scene, camera, renderer } from '../socle/rendu.js';
import { prendreLeClic } from './gestes.js';
import { versMgrs } from '../../commun/mgrs.js';
import {
    TYPES, pointAuSol, obstacles, empechement, marqueur, placer, tracer, effacerTrait, drape, altitude, fmt,
} from './mission.js';

const $ = id => document.getElementById(id);
const btnTracer = $('br-tracer'), btnCote = $('br-cote'), btnChercher = $('br-chercher'), btnEffacer = $('br-effacer');
const selDef = $('br-type-def'), selAtt = $('br-type-att'), champPortee = $('br-portee');
const caseBarbeles = $('br-barbeles'), caseMines = $('br-mines'), caseMerlon = $('br-merlon');
const resultat = $('br-resultat'), note = $('br-note');

const HAUTEUR_MERLON = 2;     // m, un merlon de bulldozer ; il masque ce qui est derrière
const VISEE_OBSTACLE = 1;     // m au-dessus du sol : là où l'on voit travailler le bréchage
const DISTANCE_MIN = { def: 300, att: 100 };   // m de l'obstacle : le défenseur hors des feux directs du bréchage, l'appui hors de l'obstacle
const ECART_RESULTATS = 150;  // m entre deux positions retenues
const NOMBRE = 5;             // positions retenues de chaque côté
const ABORDS = [200, 400];    // m en avant de l'obstacle, côté ami : d'où l'attaquant arrive
const OEIL_ABORDS = 2.5;      // m : l'attaquant qui arrive, en véhicule
const CASES = 2048;           // côté de la grille de hauteurs
const CASE_MIN = 1;           // m : plus fin ne servirait à rien, le relief est au mètre
const COULEUR_OBSTACLE = { barbeles: 0xb0b6bd, mines: 0xe5534b, merlon: 0x9b6b3d };
const COULEUR_DEF = 0xe5534b, COULEUR_ATT = 0x2f80ed;

// --- Le tracé -----------------------------------------------------------------------

let mode = null;              // 'tracer' | 'cote' | null
let sommets = [];             // points du sol de l'obstacle
let cote = 0;                 // +1 ou −1 : le côté ami, au sens du produit vectoriel
const marques = [];           // marqueurs des positions trouvées

function choisirMode(m) {
    mode = mode === m ? null : m;
    btnTracer.classList.toggle('on', mode === 'tracer');
    btnCote.classList.toggle('on', mode === 'cote');
    renderer.domElement.style.cursor = mode ? 'crosshair' : '';
    if (mode === 'tracer') note.textContent = 'Clique les points de l’obstacle, puis « Tracer » à nouveau pour finir.';
    else if (mode === 'cote') note.textContent = 'Clique du côté d’où vient l’attaquant.';
}
btnTracer.addEventListener('click', () => {
    if (mode === 'tracer') {
        choisirMode(null);
        if (sommets.length >= 2) choisirMode('cote');
        else note.textContent = 'Il faut au moins deux points.';
        majBoutons();
        return;
    }
    effacer();
    choisirMode('tracer');
});
btnCote.addEventListener('click', () => choisirMode('cote'));
btnEffacer.addEventListener('click', () => { effacer(); choisirMode(null); note.textContent = NOTE_DEPART; });
for (const c of [caseBarbeles, caseMines, caseMerlon]) c.addEventListener('change', dessinerObstacle);
const NOTE_DEPART = note.textContent;

function majBoutons() {
    btnCote.disabled = sommets.length < 2;
    btnChercher.disabled = sommets.length < 2 || !cote;
    btnEffacer.disabled = !sommets.length;
}
function effacer() {
    sommets = []; cote = 0;
    oterResultats();
    resultat.innerHTML = '';
    dessinerObstacle();
    majBoutons();
}
function oterResultats() {
    for (const m of marques) m.visible = false;
    effacerTrait('br-cote');
}

/** Le segment le plus proche de (x, z) : { i, t, d, s } ; s, le côté (signe). */
function auPlusPres(x, z) {
    let mieux = null;
    for (let i = 0; i + 1 < sommets.length; i++) {
        const a = sommets[i], b = sommets[i + 1];
        const ux = b.x - a.x, uz = b.z - a.z, L2 = ux * ux + uz * uz || 1;
        const t = Math.min(Math.max(((x - a.x) * ux + (z - a.z) * uz) / L2, 0), 1);
        const d = Math.hypot(x - a.x - ux * t, z - a.z - uz * t);
        if (!mieux || d < mieux.d) mieux = { i, t, d, s: Math.sign(ux * (z - a.z) - uz * (x - a.x)) || 1 };
    }
    // Au-delà d'un bout, à moins de 45° de l'axe : ni devant ni derrière.
    if (mieux && ((mieux.i === 0 && mieux.t === 0) || (mieux.i === sommets.length - 2 && mieux.t === 1))) {
        const a = sommets[mieux.i], b = sommets[mieux.i + 1];
        const ux = b.x - a.x, uz = b.z - a.z, n = Math.hypot(ux, uz) || 1;
        const travers = Math.abs(ux * (z - a.z) - uz * (x - a.x)) / n;
        mieux.dansLAxe = travers < Math.sqrt(Math.max(mieux.d * mieux.d - travers * travers, 0));
    }
    return mieux;
}

/** Une ligne par type d'obstacle, décalées de 3 m vers l'ennemi l'une après l'autre. */
function dessinerObstacle() {
    for (const n of ['barbeles', 'mines', 'merlon']) effacerTrait('br-' + n);
    effacerTrait('br-trace');
    if (sommets.length === 1) { tracer('br-trace', drape(sommets[0], sommets[0], 1, 1), 0xffffff); return; }
    if (sommets.length < 2) return;
    const types = typesChoisis();
    if (!types.length) { tracer('br-trace', ligneDecalee(0, 0.8), 0xffffff); return; }
    types.forEach((n, k) => tracer('br-' + n, ligneDecalee(-(cote || 1) * 3 * k, n === 'merlon' ? HAUTEUR_MERLON : 0.8), COULEUR_OBSTACLE[n]));
}
const typesChoisis = () => [['barbeles', caseBarbeles], ['mines', caseMines], ['merlon', caseMerlon]]
    .filter(([, c]) => c.checked).map(([n]) => n);
/** L'obstacle drapé sur le relief, décalé de `ecart` m sur sa normale, relevé de dh. */
function ligneDecalee(ecart, dh) {
    const pts = [];
    for (let i = 0; i + 1 < sommets.length; i++) {
        const a = sommets[i], b = sommets[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const nx = -(b.z - a.z) / L * ecart, nz = (b.x - a.x) / L * ecart;
        pts.push(...drape({ x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz }, Math.max(2, Math.ceil(L / 5)), dh));
    }
    return pts;
}

prendreLeClic((e, souris) => {
    if (!mode) return false;
    const gene = empechement();
    if (gene) { note.textContent = gene; return true; }
    const p = solSous(souris);
    if (!p) return true;
    if (mode === 'tracer') {
        sommets.push(p);
        dessinerObstacle();
    } else if (mode === 'cote') {
        cote = auPlusPres(p.x, p.z).s;
        choisirMode(null);
        dessinerObstacle();
        dessinerCote(p);
        note.textContent = 'Choisis les armes, puis « Chercher les positions ».';
    }
    majBoutons();
    return true;
});
const rayon = new THREE.Raycaster();
function solSous(souris) {
    rayon.setFromCamera(souris, camera);
    const t = rayon.intersectObjects(obstacles(), false)[0];
    return t ? pointAuSol(t.point.x, t.point.z) : null;
}

/** Une flèche du milieu de l'obstacle vers le côté ami. */
function dessinerCote() {
    const m = milieu();
    const q = auPlusPres(m.x, m.z), a = sommets[q.i], b = sommets[q.i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
    // Le côté ami est celui du signe `cote` du produit vectoriel : (−uz, ux) y mène.
    const bout = { x: m.x + nx * cote * 60, z: m.z + nz * cote * 60 };
    tracer('br-cote', drape(m, bout, 24, 1.5), COULEUR_ATT);
}
function milieu() {
    let total = 0;
    for (let i = 0; i + 1 < sommets.length; i++) total += Math.hypot(sommets[i + 1].x - sommets[i].x, sommets[i + 1].z - sommets[i].z);
    let reste = total / 2;
    for (let i = 0; i + 1 < sommets.length; i++) {
        const a = sommets[i], b = sommets[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
        if (reste <= L) return { x: a.x + (b.x - a.x) * reste / L, z: a.z + (b.z - a.z) * reste / L };
        reste -= L;
    }
    return sommets[0];
}

// --- Les armes -------------------------------------------------------------------------

TYPES.forEach((t, i) => { selDef.add(new Option(t.nom, String(i))); selAtt.add(new Option(t.nom, String(i))); });
selDef.value = String(TYPES.findIndex(t => /MMP/.test(t.nom)));
selAtt.value = String(TYPES.findIndex(t => t.nom === 'Leclerc'));

// --- La grille de hauteurs -----------------------------------------------------------

const COUCHE = 8;
const matHauteur = new THREE.ShaderMaterial({
    vertexShader: `varying float vY;
void main() {
  vec4 p = vec4(position, 1.0);
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  vec4 m = modelMatrix * p;
  vY = m.y;
  gl_Position = projectionMatrix * viewMatrix * m;
}`,
    fragmentShader: `varying float vY;
void main() { gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }`,
    side: THREE.DoubleSide,
});
const VIDE = -1e6;

/**
 * Le dessus de ce qui est affiché sur l'emprise b ({ x0, x1, z0, z1 }), vu
 * d'en haut : { h (Float32Array), n, c, x0, z0 } ; la case (i, j) couvre
 * x0 + i·c et z0 + j·c. Une case sans rien vaut VIDE.
 */
function grilleHauteurs(b) {
    const cote = Math.max(b.x1 - b.x0, b.z1 - b.z0);
    const n = Math.min(CASES, renderer.capabilities.maxTextureSize, Math.ceil(cote / CASE_MIN));
    const c = cote / n;
    const cible = new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    // Vue d'en haut, le nord (−z) en haut de l'image et l'est (+x) à droite.
    const cam = new THREE.OrthographicCamera(-cote / 2, cote / 2, cote / 2, -cote / 2, 1, 40000);
    const cx = b.x0 + cote / 2, cz = b.z0 + cote / 2;
    cam.position.set(cx, 20000, cz);
    cam.up.set(0, 0, -1);
    cam.lookAt(cx, 0, cz);
    cam.layers.set(COUCHE);
    cam.updateMatrixWorld(true);
    const objets = obstacles();
    for (const o of objets) o.layers.enable(COUCHE);
    const avant = { fond: scene.background, matiere: scene.overrideMaterial, couleur: new THREE.Color(),
                    alpha: renderer.getClearAlpha(), ombres: renderer.shadowMap.autoUpdate, cible: renderer.getRenderTarget() };
    renderer.getClearColor(avant.couleur);
    const lu = new Float32Array(n * n * 4);
    try {
        scene.background = null;
        scene.overrideMaterial = matHauteur;
        renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(cible);
        renderer.setClearColor(0x000000, 0);      // alpha nul : rien ici
        renderer.clear();
        renderer.render(scene, cam);
        renderer.readRenderTargetPixels(cible, 0, 0, n, n, lu);
    } finally {
        renderer.setRenderTarget(avant.cible);
        scene.background = avant.fond;
        scene.overrideMaterial = avant.matiere;
        renderer.setClearColor(avant.couleur, avant.alpha);
        renderer.shadowMap.autoUpdate = avant.ombres;
        for (const o of objets) o.layers.disable(COUCHE);
        cible.dispose();
    }
    // La ligne 0 lue est le bas de l'image : le sud, z le plus grand.
    const h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
        const ligne = (n - 1 - j) * n * 4;
        for (let i = 0; i < n; i++) h[j * n + i] = lu[ligne + i * 4 + 3] > 0.5 ? lu[ligne + i * 4] : VIDE;
    }
    return { h, n, c, x0: b.x0, z0: b.z0 };
}
const hauteur = (g, x, z) => {
    const i = Math.floor((x - g.x0) / g.c), j = Math.floor((z - g.z0) / g.c);
    return i < 0 || j < 0 || i >= g.n || j >= g.n ? VIDE : g.h[j * g.n + i];
};

/**
 * La droite de A à B ({x, y, z}) passe-t-elle au-dessus de la grille ? Les
 * 3 m de chaque bout sont ignorés : un œil au ras d'un toit, d'une haie, ou
 * la cible posée au sol.
 */
function passe(g, A, B) {
    const dx = B.x - A.x, dz = B.z - A.z, dy = B.y - A.y;
    const L = Math.hypot(dx, dz);
    const pas = g.c;
    for (let s = 3; s < L - 3; s += pas) {
        const t = s / L;
        if (hauteur(g, A.x + dx * t, A.z + dz * t) > A.y + dy * t + 0.1) return false;
    }
    return true;
}

/** Le merlon monté dans la grille : HAUTEUR_MERLON au-dessus du sol, sur 2 m de large. */
function monterMerlon(g) {
    const ecart = -(cote || 1) * 3 * typesChoisis().indexOf('merlon');
    for (const p of ligneDecalee(ecart, HAUTEUR_MERLON)) {
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            const i = Math.floor((p.x - g.x0) / g.c) + di, j = Math.floor((p.z - g.z0) / g.c) + dj;
            if (i >= 0 && j >= 0 && i < g.n && j < g.n) g.h[j * g.n + i] = Math.max(g.h[j * g.n + i], p.y);
        }
    }
}

// --- La recherche ------------------------------------------------------------------------

/** Points de l'obstacle, tous les L/30 m (5 m au moins), avec la normale vers le côté ami. */
function echantillons() {
    const pts = [];
    let total = 0;
    for (let i = 0; i + 1 < sommets.length; i++) total += Math.hypot(sommets[i + 1].x - sommets[i].x, sommets[i + 1].z - sommets[i].z);
    const pas = Math.max(5, total / 30);
    for (let i = 0; i + 1 < sommets.length; i++) {
        const a = sommets[i], b = sommets[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const nx = -(b.z - a.z) / L * cote, nz = (b.x - a.x) / L * cote;
        for (let s = i === 0 ? 0 : pas / 2; s <= L; s += pas) {
            const p = pointAuSol(a.x + (b.x - a.x) * s / L, a.z + (b.z - a.z) * s / L);
            if (p) pts.push({ ...p, nx, nz });
        }
    }
    return pts;
}

const dansSite = (type, A, B) => {
    if (!type.site) return true;
    const s = Math.atan2(B.y - A.y, Math.hypot(B.x - A.x, B.z - A.z)) * 3200 / Math.PI;
    return s >= type.site[0] && s <= type.site[1];
};

/** Les meilleurs, espacés d'au moins ECART_RESULTATS. */
function retenir(candidats) {
    const pris = [];
    for (const c of candidats.sort((a, b) => b.score - a.score)) {
        if (pris.length >= NOMBRE) break;
        if (pris.every(q => Math.hypot(q.x - c.x, q.z - c.z) >= ECART_RESULTATS)) pris.push(c);
    }
    return pris;
}

const q0 = p => auPlusPres(p.x, p.z).d;

async function chercher() {
    const gene = empechement();
    if (gene) { note.textContent = gene; return; }
    const def = TYPES[Number(selDef.value)], att = TYPES[Number(selAtt.value)];
    const portee = Math.min(Math.max(Number(champPortee.value) || 1500, 200), 3000);
    note.textContent = 'Calcul en cours…';
    btnChercher.disabled = true;
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const t0 = performance.now();
    try {
        const cibles = echantillons();
        const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
        for (const p of sommets) {
            b.x0 = Math.min(b.x0, p.x - portee); b.x1 = Math.max(b.x1, p.x + portee);
            b.z0 = Math.min(b.z0, p.z - portee); b.z1 = Math.max(b.z1, p.z + portee);
        }
        const g = grilleHauteurs(b);
        if (typesChoisis().includes('merlon')) monterMerlon(g);
        const visee = typesChoisis().includes('merlon') ? HAUTEUR_MERLON + 0.5 : VISEE_OBSTACLE;
        const vises = cibles.map(p => ({ x: p.x, z: p.z, y: p.y + visee }));
        // Les abords : d'où l'attaquant arrive, à 200 et 400 m devant l'obstacle.
        const abords = [];
        for (const p of cibles.filter((_, k) => k % 3 === 0)) for (const d of ABORDS) {
            const q = pointAuSol(p.x + p.nx * d, p.z + p.nz * d);
            if (q) abords.push({ x: q.x, z: q.z, y: q.y + OEIL_ABORDS });
        }
        // Les candidats : une grille de 5 000 points au plus sur l'emprise.
        const aire = (b.x1 - b.x0) * (b.z1 - b.z0);
        const pas = Math.max(g.c * 2, Math.sqrt(aire / 5000));
        const defs = [], atts = [];
        for (let z = b.z0 + pas / 2; z < b.z1; z += pas) for (let x = b.x0 + pas / 2; x < b.x1; x += pas) {
            const q = auPlusPres(x, z);
            if (q.dansLAxe || q.d < (q.s === cote ? DISTANCE_MIN.att : DISTANCE_MIN.def) || q.d > portee) continue;
            const sol = pointAuSol(x, z);
            if (!sol) continue;
            // Dans un bâtiment ou sous un arbre : pas une position au sol.
            if (hauteur(g, x, z) - sol.y > 1.5) continue;
            (q.s === cote ? atts : defs).push(sol);
        }
        // Défenseur : voit l'obstacle, à portée et dans son débattement ; caché des abords.
        for (const p of defs) {
            const oeil = { x: p.x, z: p.z, y: p.y + def.optique };
            let vus = 0;
            for (const v of vises) if (Math.hypot(v.x - p.x, v.z - p.z) <= portee && dansSite(def, oeil, v) && passe(g, oeil, v)) vus++;
            p.vue = vus / vises.length;
            if (p.vue < 0.2) { p.score = -1; continue; }
            const tete = { x: p.x, z: p.z, y: p.y + def.expo };
            let vu = 0;
            for (const a of abords) if (passe(g, a, tete)) vu++;
            p.expose = abords.length ? vu / abords.length : 0;
            // À égalité, le plus près : le tir y est plus précis.
            p.score = p.vue - 0.5 * p.expose - 0.01 * q0(p) / portee;
        }
        const defenseurs = retenir(defs.filter(p => p.score >= 0));
        // Appui : voit l'obstacle dans le débattement de son arme, et les défenseurs trouvés.
        for (const p of atts) {
            const oeil = { x: p.x, z: p.z, y: p.y + att.optique };
            let vus = 0;
            for (const v of vises) if (Math.hypot(v.x - p.x, v.z - p.z) <= portee && dansSite(att, oeil, v) && passe(g, oeil, v)) vus++;
            p.vue = vus / vises.length;
            if (p.vue < 0.2) { p.score = -1; continue; }
            let d = 0;
            for (const q of defenseurs) {
                const tete = { x: q.x, z: q.z, y: q.y + def.expo };
                if (Math.hypot(q.x - p.x, q.z - p.z) <= portee && dansSite(att, oeil, tete) && passe(g, oeil, tete)) d++;
            }
            p.defenseurs = defenseurs.length ? d / defenseurs.length : 0;
            p.score = 0.6 * p.vue + 0.4 * p.defenseurs - 0.01 * q0(p) / portee;
        }
        const appuis = retenir(atts.filter(p => p.score >= 0));
        afficher(defenseurs, appuis, def, att);
        derniere = { defenseurs, appuis, candidats: defs.length + atts.length, case: g.c, ms: performance.now() - t0,
                     hauteur: (x, z) => hauteur(g, x, z) };
        note.textContent = `${fmt(defs.length + atts.length)} positions essayées tous les ${fmt(pas)} m, grille de `
            + `${fmt(g.c, 1)} m, en ${fmt((performance.now() - t0) / 1000, 1)} s. Sur ce qui est affiché `
            + '(relief, bâtiments, végétation) : à vérifier en y posant un poste.';
    } finally {
        btnChercher.disabled = false;
    }
}
btnChercher.addEventListener('click', chercher);
let derniere = null;

function afficher(defenseurs, appuis, def, att) {
    oterResultats();
    dessinerCote();
    const pct = v => `${fmt(100 * v)} %`;
    const ligne = (nom, p, detail) => `<div class="stat"><span>${nom}</span><b>${versMgrs(p.lon, p.lat) || '—'} · ${fmt(altitude(p.y))} m</b></div>`
        + `<div class="br-detail">${detail}</div>`;
    let html = `<h3 class="br-titre def">Défenseur (${def.nom})</h3>`;
    if (!defenseurs.length) html += '<div class="br-detail">Aucune position ne voit 20 % de l’obstacle.</div>';
    defenseurs.forEach((p, k) => {
        poserMarque(k, p, COULEUR_DEF, def.optique, `D${k + 1}`);
        html += ligne(`D${k + 1}`, p, `voit ${pct(p.vue)} de l’obstacle · vu de ${pct(p.expose)} des abords · à ${fmt(auPlusPres(p.x, p.z).d)} m`);
    });
    html += `<h3 class="br-titre att">Appui de l’attaquant (${att.nom})</h3>`;
    if (!appuis.length) html += '<div class="br-detail">Aucune position ne voit 20 % de l’obstacle.</div>';
    appuis.forEach((p, k) => {
        poserMarque(NOMBRE + k, p, COULEUR_ATT, att.optique, `A${k + 1}`);
        html += ligne(`A${k + 1}`, p, `voit ${pct(p.vue)} de l’obstacle · ${pct(p.defenseurs)} des positions D · à ${fmt(auPlusPres(p.x, p.z).d)} m`);
    });
    resultat.innerHTML = html;
}
function poserMarque(k, p, couleur, h, nom) {
    if (!marques[k]) {
        marques[k] = marqueur(couleur);
        marques[k].userData.etiquette = etiquette(nom, couleur);
        marques[k].add(marques[k].userData.etiquette);
    }
    placer(marques[k], p, h);
    marques[k].userData.etiquette.position.y = p.base + h + 6;
}
/** Le nom de la position (D1, A2…), toujours lisible au-dessus du marqueur. */
function etiquette(nom, couleur) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#' + couleur.toString(16).padStart(6, '0');
    ctx.beginPath(); ctx.roundRect(2, 2, 60, 28, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(nom, 32, 17);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
    s.scale.set(0.05, 0.025, 1);
    s.renderOrder = 22;
    return s;
}

majBoutons();

/** L'état du module, pour les essais. */
export const etatBrechage = () => ({ sommets, cote, mode, derniere });
