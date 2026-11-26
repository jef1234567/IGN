// Bréchage : un obstacle tracé sur le terrain (barbelés, champ de mines,
// merlon, seuls ou ensemble), montré en volume, puis la carte de
// l'intervisibilité : de chaque endroit alentour, la part de l'obstacle qu'on
// y voit, en carte de chaleur, et les dix endroits d'où l'on en voit le plus.
// Pas de camp à choisir : ce qui voit l'obstacle est aussi ce que l'obstacle
// voit, au défenseur qui le surveille comme à l'attaquant qui appuie.
//
// Juger des milliers d'endroits avec les cartes cubiques de la préparation de
// mission prendrait des minutes : le dessus de ce qui est affiché (relief,
// bâtiments, végétation, et le merlon) est rendu une fois, vu d'en haut, dans
// une grille de hauteurs, et chaque ligne de vue y est suivie pas à pas, sur
// le processeur. 1,5 m par case pour un obstacle cherché à 1 500 m : un mur
// plus mince qu'une case peut y manquer, un arbre isolé y masque comme un
// mur. Ordres de grandeur, à vérifier par la ligne de vue d'un poste.

import * as THREE from 'three';
import { scene, camera, renderer } from '../socle/rendu.js';
import { prendreLeClic } from './gestes.js';
import { versMgrs } from '../../commun/mgrs.js';
import {
    TYPES, altitudePoint, pointAuSol, solsVises, sols, obstacles, reliefPret, recaler, HORS_RELIEF,
    quandModeMission, couperModeMission, empechement, marqueur, placer, fmt,
} from './mission.js';

const $ = id => document.getElementById(id);
const btnTracer = $('br-tracer'), btnCalculer = $('br-chercher'), btnEffacer = $('br-effacer');
const selOeil = $('br-oeil'), champPortee = $('br-portee');
const caseBarbeles = $('br-barbeles'), caseMines = $('br-mines'), caseMerlon = $('br-merlon');
const resultat = $('br-resultat'), note = $('br-note'), legende = $('br-legende');

const HAUTEUR_MERLON = 2;     // m, un merlon de bulldozer : il masque ce qui est derrière lui
const VISEE_OBSTACLE = 1;     // m au-dessus du sol : là où l'on voit travailler le bréchage
const PRES = 25;              // m : plus près de l'obstacle, on est dedans
const ECART_ZONES = 120;      // m entre deux zones retenues
const ZONE_MIN = 100;         // m de l'obstacle au moins pour une zone retenue
const NOMBRE = 10;            // zones retenues
// Côté de la carte de chaleur, en cellules : 24 m à 1 500 m. 160 cellules et
// trente points d'obstacle prenaient 9,8 s dans l'essai, 128 et vingt 4 s.
const CELLULES = 128;
const CASES = 2048;           // côté de la grille de hauteurs
const CASE_MIN = 1;           // m : plus fin ne servirait à rien, le relief est au mètre
const COULEUR_ZONE = 0xf2c94c;

// --- Le tracé -----------------------------------------------------------------------

let mode = null;              // 'tracer' | null
let sommets = [];             // points du sol de l'obstacle
const marques = [];           // marqueurs des zones trouvées

function choisirMode(m) {
    mode = mode === m ? null : m;
    // Un seul mode de clic à la fois : celui de la mission, pris avant le
    // nôtre, gardait sinon tous les clics.
    if (mode) couperModeMission();
    btnTracer.textContent = mode === 'tracer' ? 'Terminer le tracé' : 'Tracer l’obstacle';
    btnTracer.classList.toggle('on', mode === 'tracer');
    renderer.domElement.style.cursor = mode ? 'crosshair' : '';
    if (mode === 'tracer') note.textContent = 'Clique les points de l’obstacle sur le terrain ; double-clic sur le dernier, ou « Terminer le tracé », pour finir.';
}
function finirTrace() {
    choisirMode(null);
    if (sommets.length < 2) { effacer(); note.textContent = 'Il faut au moins deux points : recommence le tracé.'; }
    else note.textContent = `Obstacle de ${fmt(longueur())} m. Choisis la hauteur d’observation, puis « Calculer l’intervisibilité ».`;
    majBoutons();
}
btnTracer.addEventListener('click', () => {
    if (mode === 'tracer') { finirTrace(); return; }
    effacer();
    choisirMode('tracer');
});
quandModeMission(() => { if (mode) choisirMode(mode); });
/** Coupe le tracé de l'obstacle, s'il est en cours (le tir indirect s'y coupe). */
export function couperModeBrechage() { if (mode) choisirMode(mode); }
btnEffacer.addEventListener('click', () => { effacer(); choisirMode(null); note.textContent = NOTE_DEPART; });
for (const c of [caseBarbeles, caseMines, caseMerlon]) c.addEventListener('change', () => { dessinerObstacle(); oterResultats(); });
const NOTE_DEPART = note.textContent;

function majBoutons() {
    btnCalculer.disabled = sommets.length < 2 || mode === 'tracer';
    btnEffacer.disabled = !sommets.length;
}
function effacer() {
    sommets = [];
    oterResultats();
    dessinerObstacle();
    majBoutons();
}
function oterResultats() {
    for (const m of marques) m.visible = false;
    calque.visible = false;
    legende.hidden = true;
    resultat.innerHTML = '';
    derniere = null;
}

/** Distance de (x, z) à l'obstacle. */
function distanceObstacle(x, z) {
    let d = Infinity;
    for (let i = 0; i + 1 < sommets.length; i++) {
        const a = sommets[i], b = sommets[i + 1];
        const ux = b.x - a.x, uz = b.z - a.z, L2 = ux * ux + uz * uz || 1;
        const t = Math.min(Math.max(((x - a.x) * ux + (z - a.z) * uz) / L2, 0), 1);
        d = Math.min(d, Math.hypot(x - a.x - ux * t, z - a.z - uz * t));
    }
    return d;
}
function longueur() {
    let total = 0;
    for (let i = 0; i + 1 < sommets.length; i++) total += Math.hypot(sommets[i + 1].x - sommets[i].x, sommets[i + 1].z - sommets[i].z);
    return total;
}
const typesChoisis = () => [['barbeles', caseBarbeles], ['mines', caseMines], ['merlon', caseMerlon]]
    .filter(([, c]) => c.checked).map(([n]) => n);

/**
 * Points le long de l'obstacle, tous les `pas` m, décalés de `ecart` m sur sa
 * normale : { x, z, y (sol), ux, uz (direction) }.
 */
function longer(pas, ecart = 0) {
    const pts = [];
    for (let i = 0; i + 1 < sommets.length; i++) {
        const a = sommets[i], b = sommets[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
        for (let s = i === 0 ? 0 : pas / 2; s <= L; s += pas) {
            const x = a.x + ux * s - uz * ecart, z = a.z + uz * s + ux * ecart;
            const p = pointAuSol(x, z);
            if (p) pts.push({ x, z, y: p.y, ux, uz });
        }
    }
    return pts;
}

// --- L'obstacle en volume -------------------------------------------------------------
// Les bandes côte à côte : le merlon sur le tracé, les barbelés à 4 m d'un
// côté, les mines sur une bande de 4 m de l'autre. Un trait pâle au sol les
// suit, pour les retrouver de loin.

const groupeObstacle = new THREE.Group();
scene.add(groupeObstacle);
const MAT = {
    merlon: new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 1, flatShading: true }),
    fil: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.45 }),
    piquet: new THREE.MeshStandardMaterial({ color: 0x4a4f45, roughness: 0.8 }),
    mine: new THREE.MeshStandardMaterial({ color: 0x4b5a2e, roughness: 0.7 }),
    bande: new THREE.MeshBasicMaterial({ color: 0xe5534b, transparent: true, opacity: 0.35, depthWrite: false }),
    trace: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }),
};
const ECARTS = { merlon: 0, barbeles: 4, mines: -4 };

function viderObstacle() {
    for (const o of [...groupeObstacle.children]) {
        groupeObstacle.remove(o);
        if (o.geometry) o.geometry.dispose();
    }
}
function dessinerObstacle() {
    viderObstacle();
    if (!sommets.length) return;
    // Le tracé, toujours : un trait blanc posé sur le relief, vu à travers tout.
    const trace = longer(2).map(p => new THREE.Vector3(p.x, p.y + 0.3, p.z));
    if (sommets.length === 1) trace.push(new THREE.Vector3(sommets[0].x, sommets[0].y + 3, sommets[0].z));
    const ligne = new THREE.Line(new THREE.BufferGeometry().setFromPoints(trace), MAT.trace);
    ligne.renderOrder = 21;
    groupeObstacle.add(ligne);
    if (sommets.length < 2) return;
    const types = typesChoisis();
    if (types.includes('merlon')) groupeObstacle.add(merlon());
    if (types.includes('barbeles')) groupeObstacle.add(...barbeles());
    if (types.includes('mines')) groupeObstacle.add(...mines());
}

/** Le merlon : un talus de 2 m, 5 m à la base, 1 m au sommet, posé sur le relief. */
function merlon() {
    const demiBase = 2.5, demiHaut = 0.5;
    const pts = longer(2, ECARTS.merlon);
    const pos = [], index = [];
    for (const p of pts) {
        const nx = -p.uz, nz = p.ux;
        for (const [d, h] of [[-demiBase, -0.3], [-demiHaut, HAUTEUR_MERLON], [demiHaut, HAUTEUR_MERLON], [demiBase, -0.3]]) {
            pos.push(p.x + nx * d, p.y + h, p.z + nz * d);
        }
    }
    for (let k = 0; k + 1 < pts.length; k++) {
        for (let f = 0; f < 3; f++) {
            const a = k * 4 + f, b = a + 1, c = a + 4, d = a + 5;
            index.push(a, c, b, b, c, d);
        }
    }
    // Les deux bouts, fermés.
    for (const k of [0, pts.length - 1]) {
        const a = k * 4;
        if (k === 0) index.push(a, a + 1, a + 2, a, a + 2, a + 3);
        else index.push(a, a + 2, a + 1, a, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, MAT.merlon);
    m.material.side = THREE.DoubleSide;
    return m;
}

/** Les barbelés : des rouleaux de concertina de 0,9 m, un piquet tous les 3 m. */
function barbeles() {
    const pts = longer(0.3, ECARTS.barbeles).slice(0, 6000);
    const anneau = new THREE.TorusGeometry(0.45, 0.012, 4, 20);
    const rouleaux = new THREE.InstancedMesh(anneau, MAT.fil, pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    pts.forEach((p, i) => {
        // Chaque spire face à l'axe, un peu penchée, d'un côté puis de l'autre.
        e.set(0, Math.atan2(p.ux, p.uz), (i % 2 ? 0.35 : -0.35));
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(p.x, p.y + 0.45, p.z), q, new THREE.Vector3(1, 1, 1));
        rouleaux.setMatrixAt(i, m);
    });
    const piquetsPts = longer(3, ECARTS.barbeles);
    const piquets = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2, 5), MAT.piquet, piquetsPts.length);
    piquetsPts.forEach((p, i) => { m.makeTranslation(p.x, p.y + 0.6, p.z); piquets.setMatrixAt(i, m); });
    return [rouleaux, piquets];
}

/** Les mines : trois rangées en quinconce sur une bande de 4 m, une mine tous les 2,5 m par rangée. */
function mines() {
    const rangs = [-1.5, 0, 1.5].map((r, k) => longer(2.5, ECARTS.mines + r).map(p => ({ ...p, decal: k % 2 ? 1.25 : 0 })));
    const toutes = rangs.flat().slice(0, 6000);
    const geo = new THREE.CylinderGeometry(0.15, 0.17, 0.08, 12);
    const m = new THREE.InstancedMesh(geo, MAT.mine, toutes.length);
    const mat4 = new THREE.Matrix4();
    toutes.forEach((p, i) => {
        const x = p.x + p.ux * p.decal, z = p.z + p.uz * p.decal;
        const s = pointAuSol(x, z);
        mat4.makeTranslation(x, (s ? s.y : p.y) + 0.04, z);
        m.setMatrixAt(i, mat4);
    });
    // La bande au sol, rouge pâle : le champ se voit de loin.
    const bord = [ -2.5, 2.5 ].map(r => longer(2, ECARTS.mines + r));
    const pos = [], index = [];
    const n = Math.min(bord[0].length, bord[1].length);
    for (let k = 0; k < n; k++) {
        pos.push(bord[0][k].x, bord[0][k].y + 0.15, bord[0][k].z, bord[1][k].x, bord[1][k].y + 0.15, bord[1][k].z);
        if (k + 1 < n) index.push(2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 1, 2 * k + 2, 2 * k + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(index);
    const bande = new THREE.Mesh(g, MAT.bande);
    bande.material.side = THREE.DoubleSide;
    bande.renderOrder = 9;
    return [m, bande];
}

// --- Le clic ---------------------------------------------------------------------------

const rayon = new THREE.Raycaster();
let dernierClic = null;       // { t, x, y } : l'instant et la place du dernier clic, en pixels
function solSous(souris) {
    rayon.setFromCamera(souris, camera);
    const t = rayon.intersectObjects(solsVises().concat(obstacles()), false)[0];
    return t ? pointAuSol(t.point.x, t.point.z) : null;
}
prendreLeClic((e, souris) => {
    if (!mode) return false;
    const gene = empechement();
    if (gene) { note.textContent = gene; return true; }
    // Un second clic au même endroit (6 pixels) ne pose pas de point : en
    // moins de 400 ms, c'est un double-clic, qui finit le tracé.
    const t = performance.now();
    if (dernierClic && Math.hypot(e.clientX - dernierClic.x, e.clientY - dernierClic.y) < 6) {
        if (t - dernierClic.t < 400) { dernierClic = null; finirTrace(); }
        else dernierClic.t = t;
        return true;
    }
    dernierClic = { t, x: e.clientX, y: e.clientY };
    const p = solSous(souris);
    if (!p) { note.textContent = HORS_RELIEF; return true; }
    sommets.push(p);
    oterResultats();
    dessinerObstacle();
    const n = sommets.length;
    note.textContent = n < 2 ? 'Premier point posé : clique le suivant.'
        : `${n} points, ${fmt(longueur())} m : clique le suivant, ou double-clic / « Terminer le tracé ».`;
    majBoutons();
    return true;
});

// --- La hauteur d'observation ---------------------------------------------------------

TYPES.forEach((t, i) => selOeil.add(new Option(`${t.nom} (œil à ${fmt(t.optique, 1)} m)`, String(i))));
selOeil.value = String(TYPES.findIndex(t => /genou/.test(t.nom)));
selOeil.addEventListener('change', oterResultats);

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
    // Les mêmes points que hauteur(g, A + t·(B − A)) tous les g.c mètres,
    // en cases et sans appel : la carte de chaleur en suit des centaines de
    // milliers.
    const { h, n, c } = g, ix = (A.x - g.x0) / c, iz = (A.z - g.z0) / c;
    const kx = dx / L / c, kz = dz / L / c, ky = dy / L, y0 = A.y + 0.1;
    for (let s = 3; s < L - 3; s += c) {
        const i = Math.floor(ix + kx * s), j = Math.floor(iz + kz * s);
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        if (h[j * n + i] > y0 + ky * s) return false;
    }
    return true;
}


/** Le merlon monté dans la grille : sa crête, HAUTEUR_MERLON au-dessus du sol, sur 3 m de large. */
function monterMerlon(g) {
    for (const p of longer(1, ECARTS.merlon)) {
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            const i = Math.floor((p.x - g.x0) / g.c) + di, j = Math.floor((p.z - g.z0) / g.c) + dj;
            if (i >= 0 && j >= 0 && i < g.n && j < g.n) g.h[j * g.n + i] = Math.max(g.h[j * g.n + i], p.y + HAUTEUR_MERLON);
        }
    }
}

// --- L'intervisibilité --------------------------------------------------------------------
// Pour chaque cellule de la carte (24 m à 1 500 m), un œil posé au sol à la
// hauteur choisie, et la part des points de l'obstacle (vingt au plus, tous
// les 5 m au moins) qu'il voit à moins de la portée. Une cellule dans un
// bâtiment ou sous un arbre n'est pas jugée : pas un endroit où se poster au
// sol. Le merlon, lui, masque : on vise sa crête, le reste est derrière.

let derniere = null;

async function calculer() {
    const gene = empechement();
    if (gene) { note.textContent = gene; return; }
    const oeil = TYPES[Number(selOeil.value)].optique;
    const portee = Math.min(Math.max(Number(champPortee.value) || 1500, 200), 3000);
    if (!reliefPret(sommets, portee, () => { for (const p of sommets) recaler(p); dessinerObstacle(); calculer(); }, note)) return;
    note.textContent = 'Calcul de l’intervisibilité…';
    btnCalculer.disabled = true;
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const t0 = performance.now();
    try {
        const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
        for (const p of sommets) {
            b.x0 = Math.min(b.x0, p.x - portee); b.x1 = Math.max(b.x1, p.x + portee);
            b.z0 = Math.min(b.z0, p.z - portee); b.z1 = Math.max(b.z1, p.z + portee);
        }
        const cote = Math.max(b.x1 - b.x0, b.z1 - b.z0);
        b.x1 = b.x0 + cote; b.z1 = b.z0 + cote;
        const g = grilleHauteurs(b);
        const merlonPose = typesChoisis().includes('merlon');
        if (merlonPose) monterMerlon(g);
        const visee = merlonPose ? HAUTEUR_MERLON + 0.3 : VISEE_OBSTACLE;
        const pas = Math.max(5, longueur() / 20);
        const cibles = longer(pas).map(p => ({ x: p.x, z: p.z, y: p.y + visee }));
        const N = CELLULES, c = cote / N;
        const valeurs = new Float32Array(N * N).fill(-1);
        const cellules = [];
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const x = b.x0 + (i + 0.5) * c, z = b.z0 + (j + 0.5) * c;
                const d = distanceObstacle(x, z);
                if (d < PRES || d > portee) continue;
                const sol = pointAuSol(x, z);
                if (!sol || hauteur(g, x, z) - sol.y > 1.5) continue;
                const A = { x, z, y: sol.y + oeil };
                let vus = 0;
                for (const v of cibles) if (Math.hypot(v.x - x, v.z - z) <= portee && passe(g, A, v)) vus++;
                const f = vus / cibles.length;
                valeurs[j * N + i] = f;
                if (f > 0 && d >= ZONE_MIN) cellules.push({ ...sol, f, d });
            }
            // Laisser la page respirer et dire où en est le calcul, quatre fois :
            // chaque pause rend une image (300 ms sous un GPU logiciel).
            if (j % 32 === 31) {
                note.textContent = `Calcul de l’intervisibilité… ${Math.round(100 * (j + 1) / N)} %`;
                await new Promise(r => setTimeout(r, 0));
            }
        }
        poserCalque(valeurs, N, b);
        // Les zones : les meilleures cellules à 100 m de l'obstacle au moins
        // (plus près, tout se voit), à 120 m l'une de l'autre au moins.
        // À part égale, le plus loin : vu d'aussi bien, de plus loin.
        cellules.sort((p, q) => q.f - p.f || q.d - p.d);
        const zones = [];
        for (const p of cellules) {
            if (zones.length >= NOMBRE) break;
            if (zones.every(q => Math.hypot(q.x - p.x, q.z - p.z) >= ECART_ZONES)) zones.push(p);
        }
        afficher(zones, oeil);
        const ms = performance.now() - t0;
        derniere = { zones, cellules: cellules.length, case: g.c, ms, hauteur: (x, z) => hauteur(g, x, z) };
        note.textContent = `${fmt(cellules.length)} endroits voient au moins un point de l’obstacle (cellules de ${fmt(c)} m, `
            + `en ${fmt(ms / 1000, 1)} s). Sur ce qui est affiché (relief, bâtiments, végétation) : à vérifier en y posant un poste.`;
    } finally {
        majBoutons();
    }
}
btnCalculer.addEventListener('click', calculer);

// --- La carte de chaleur ---------------------------------------------------------------
// Une texture de N × N valeurs drapée d'en haut sur le sol des calculs : de
// transparent (rien) au bleu (un peu), au jaune puis au rouge (tout).

const matChaleur = new THREE.ShaderMaterial({
    uniforms: { uCarte: { value: null }, uBornes: { value: new THREE.Vector4() } },
    vertexShader: `varying vec2 vXZ;
void main() { vec4 m = modelMatrix * vec4(position, 1.0); vXZ = m.xz; gl_Position = projectionMatrix * viewMatrix * m; }`,
    fragmentShader: `uniform sampler2D uCarte; uniform vec4 uBornes; varying vec2 vXZ;
vec3 teinte(float f) {
  vec3 a = vec3(0.17, 0.48, 0.91), b = vec3(0.98, 0.85, 0.20), c = vec3(0.90, 0.16, 0.12);
  return f < 0.5 ? mix(a, b, f * 2.0) : mix(b, c, f * 2.0 - 1.0);
}
void main() {
  vec2 uv = (vXZ - uBornes.xy) / (uBornes.zw - uBornes.xy);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  float f = texture2D(uCarte, uv).r;
  if (f <= 0.0) discard;
  gl_FragColor = vec4(teinte(f), 0.18 + 0.30 * f);
}`,
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -40,
});
const calque = new THREE.Group();
calque.visible = false;
scene.add(calque);

function poserCalque(valeurs, N, b) {
    matChaleur.uniforms.uCarte.value?.dispose();
    const tex = new THREE.DataTexture(valeurs, N, N, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    matChaleur.uniforms.uCarte.value = tex;
    matChaleur.uniforms.uBornes.value.set(b.x0, b.z0, b.x1, b.z1);
    calque.clear();
    for (const s of sols()) {
        const m = new THREE.Mesh(s.geometry, matChaleur);
        m.matrixAutoUpdate = false;
        s.updateMatrixWorld();
        m.matrix.copy(s.matrixWorld);
        m.renderOrder = 10;
        m.frustumCulled = false;
        calque.add(m);
    }
    calque.visible = true;
    legende.hidden = false;
}

function afficher(zones, oeil) {
    for (const m of marques) m.visible = false;
    const pct = v => `${fmt(100 * v)} %`;
    let html = `<h3 class="br-titre">Les ${zones.length} meilleurs endroits, œil à ${fmt(oeil, 1)} m</h3>`;
    if (!zones.length) html += '<div class="br-detail">Aucun endroit ne voit l’obstacle : relève l’œil, ou allonge la portée.</div>';
    zones.forEach((p, k) => {
        if (!marques[k]) {
            marques[k] = marqueur(COULEUR_ZONE);
            marques[k].userData.etiquette = etiquette(String(k + 1), 0xc9a227);
            marques[k].add(marques[k].userData.etiquette);
        }
        placer(marques[k], p, oeil);
        marques[k].userData.etiquette.position.y = oeil + 6;
        html += `<div class="stat"><span>${k + 1}</span><b>${versMgrs(p.lon, p.lat) || '—'} · ${fmt(altitudePoint(p))} m</b></div>`
            + `<div class="br-detail">voit ${pct(p.f)} de l’obstacle · à ${fmt(p.d)} m</div>`;
    });
    resultat.innerHTML = html;
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
export const etatBrechage = () => ({ sommets, mode, derniere });

/**
 * Pour l'audit des calculs (outils/audit-vues.mjs) : la ligne de vue de chaque
 * paire [A, B] ({ lon, lat, h }) suivie dans la grille de hauteurs.
 */
export async function grilleEssai(paires) {
    const { toLocal } = await import('../socle/projection.js');
    const pt = q => { const [x, y] = toLocal(q.lon, q.lat); return pointAuSol(x, -y); };
    const pts = paires.flat().map(pt);
    await new Promise((ok, ko) => { if (reliefPret(pts, 50, ok, note)) ok(); setTimeout(() => ko(new Error('relief')), 60000); });
    const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const p of paires.flat().map(pt)) {
        b.x0 = Math.min(b.x0, p.x - 50); b.x1 = Math.max(b.x1, p.x + 50);
        b.z0 = Math.min(b.z0, p.z - 50); b.z1 = Math.max(b.z1, p.z + 50);
    }
    const g = grilleHauteurs(b);
    return paires.map(([A, B]) => {
        const a = pt(A), c = pt(B);
        return passe(g, { x: a.x, z: a.z, y: a.y + A.h }, { x: c.x, z: c.z, y: c.y + B.h });
    });
}
