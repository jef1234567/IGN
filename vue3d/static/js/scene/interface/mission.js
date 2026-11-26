// Préparation de mission : un poste posé sur le terrain, ce qu'il voit et
// qui le voit, la ligne de vue vers un point avec son profil, la vue depuis
// son optique, et les mesures (distance, azimut en milliemes, dénivelé,
// MGRS).
//
// Tout se calcule sur ce que la scène montre : relief, anneau, bâtiments et
// végétation affichés. Masquer la végétation (son bouton) revient donc à
// voir à travers elle. La carte des vues tient dans une carte de distances
// cubique rendue depuis le poste, comme l'ombre d'une lampe : un point du sol
// est vu si rien n'est plus proche du poste dans sa direction. La ligne de vue
// est un lancer de rayon sur les mêmes objets, et dit ce qui masque.
//
// La visibilité est réciproque : la droite qui joint mon optique au point
// exposé de l'ennemi est celle de « ce que je vois » ; celle qui joint mon
// point exposé à son optique, celle de « qui me voit ». Les deux cartes ne
// diffèrent que par ces hauteurs.

import * as THREE from 'three';
import { scene, camera, renderer, controls, host } from '../socle/rendu.js';
import { toLonLat } from '../socle/projection.js';
import { terrain, anneauRelief, altitudeRef, exagVert, relief } from '../terrain/etat.js';
import { ySolPartout } from '../terrain/horizon.js';
import { groupeBatiments } from '../batiments/etat.js';
import { groupeVegetation } from '../vegetation/etat.js';
import { groupeVegSimple } from '../vegetation/couche.js';
import { prendreLeClic, prendreLaMolette } from './gestes.js';
import { orbite, arreterOrbite } from './boutons.js';
import { droneActif } from './drone.js';
import { versMgrs, azimutMilliemes, convergenceMilliemes } from '../../commun/mgrs.js';

const $ = id => document.getElementById(id);

// Hauteurs au-dessus du sol, en mètres : l'optique (œil, épiscope, viseur)
// et le point le plus haut qui dépasse (tête, toit de tourelle). Ordres de
// grandeur, pas une fiche technique : les champs se corrigent.
const TYPES = [
    ['Fantassin couché', 0.4, 0.5],
    ['Fantassin à genou', 1.0, 1.2],
    ['Fantassin debout', 1.6, 1.8],
    ['Poste MMP au sol', 0.5, 0.7],
    ['VBCI', 2.6, 3.0],
    ['Griffon', 2.9, 3.3],
    ['Jaguar', 2.6, 3.0],
    ['Leclerc', 2.3, 2.5],
];
function remplirTypes(select, optique, expo, defaut) {
    TYPES.forEach(([nom], i) => select.add(new Option(`${nom} (≈)`, String(i))));
    select.add(new Option('Hauteurs saisies', 'libre'));
    const appliquer = () => {
        const t = TYPES[Number(select.value)];
        if (t) { optique.value = t[1]; expo.value = t[2]; }
    };
    select.value = String(defaut);
    appliquer();
    select.addEventListener('change', () => { appliquer(); recalculer(); });
    for (const c of [optique, expo]) c.addEventListener('change', () => {
        select.value = 'libre';
        recalculer();
    });
}
const lire = id => Math.max(0, Number($(id).value) || 0);
const hauteurs = () => ({
    optiqueMoi: lire('mi-optique-moi'), expoMoi: lire('mi-expo-moi'),
    optiqueLui: lire('mi-optique-lui'), expoLui: lire('mi-expo-lui'),
    portee: Math.max(50, Number($('mi-portee').value) || 1500),
});

const btnPoser = $('mi-poser'), btnLdv = $('mi-ldv'), btnMesurer = $('mi-mesurer');
const btnVues = $('mi-vues'), btnVu = $('mi-vu'), btnRegard = $('mi-regard');
const note = $('mi-note'), resultat = $('mi-resultat'), profil = $('mi-profil');
const NOTE_DEPART = note.textContent;

// --- Le sol sous le pointeur, les obstacles -------------------------------------

const rayon = new THREE.Raycaster();
function visible(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
}
const sols = () => [terrain && terrain.mesh, anneauRelief && anneauRelief.mesh].filter(Boolean);
/** Ce qui peut masquer : le sol, et les bâtiments et la végétation affichés. */
function obstacles() {
    const liste = sols();
    for (const g of [groupeBatiments, groupeVegetation, groupeVegSimple]) {
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
function pointAuSol(x, z) {
    const [lon, lat] = toLonLat(x, -z);
    const y = ySolPartout(lon, lat);
    return y == null ? null : { x, z, y, lon, lat };
}
/** Point du sol sous la souris (coordonnées normalisées), ou null. */
function solSous(souris) {
    rayon.setFromCamera(souris, camera);
    rayon.near = 0; rayon.far = Infinity;
    const t = rayon.intersectObjects(sols(), false)[0];
    return t ? pointAuSol(t.point.x, t.point.z) : null;
}
/** Altitude vraie d'un Y de la scène (exagération à 1, vérifiée avant). */
const altitude = y => y + altitudeRef;
const enHaut = (p, h) => new THREE.Vector3(p.x, p.y + h, p.z);

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
const COULEUR_MOI = 0x2f80ed, COULEUR_LUI = 0xe5534b, COULEUR_MESURE = 0xf2c94c;
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
/** Pose un marqueur au point du sol p, optique à h mètres. */
function placer(m, p, h) {
    const { mat, boule, fantome } = m.userData.parties;
    m.position.set(p.x, p.y, p.z);
    mat.scale.y = Math.max(h, 0.05);
    mat.position.y = h / 2;
    boule.position.y = fantome.position.y = h;
    m.visible = true;
}
const marqueurPoste = marqueur(COULEUR_MOI);
const marqueurCible = marqueur(COULEUR_LUI);
const marqueurA = marqueur(COULEUR_MESURE), marqueurB = marqueur(COULEUR_MESURE);
// Vus de haut, une boule de 0,6 m et un anneau de 2 m se perdent : ils
// grossissent avec la distance à la caméra, au-delà de 120 m.
function grossirMarqueurs() {
    for (const m of [marqueurPoste, marqueurCible, marqueurA, marqueurB]) {
        if (!m.visible) continue;
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
const ligneStat = (nom, valeur, classe = '') =>
    `<div class="stat"><span>${nom}</span><b${classe ? ` class="${classe}"` : ''}>${valeur}</b></div>`;
/** Distance, azimut et dénivelé de a vers b, points du sol. */
function mesure(a, b) {
    const de = b.x - a.x, dn = -(b.z - a.z);
    const horizontale = Math.hypot(de, dn), denivele = b.y - a.y;
    return {
        horizontale, denivele,
        oblique: Math.hypot(horizontale, denivele),
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
        + ligneStat('dénivelé', `${m.denivele >= 0 ? '+' : ''}${fmt(m.denivele, 1)} m (pente ${fmt(m.pente, 1)} %)`);
}
const lignePoint = (nom, p) => ligneStat(nom, `${versMgrs(p.lon, p.lat) || '—'} · ${fmt(altitude(p.y))} m`);

// --- État et modes de clic ----------------------------------------------------------

let poste = null, cible = null, mesureA = null, mesureB = null;
let modeClic = null;          // 'poser' | 'ldv' | 'mesurer' | null
let carte = null;             // 'vues' | 'vu' | null
const BOUTONS_MODE = { poser: btnPoser, ldv: btnLdv, mesurer: btnMesurer };

function choisirMode(m) {
    modeClic = modeClic === m ? null : m;
    for (const [k, b] of Object.entries(BOUTONS_MODE)) b.classList.toggle('on', k === modeClic);
    renderer.domElement.style.cursor = modeClic ? 'crosshair' : '';
    if (modeClic === 'ldv' && !poste) note.textContent = 'Pose d’abord le poste.';
    else if (modeClic === 'mesurer') note.textContent = 'Clique le point de départ, puis le point d’arrivée.';
    else if (modeClic) note.textContent = 'Clique sur le terrain.';
}
btnPoser.addEventListener('click', () => choisirMode('poser'));
btnLdv.addEventListener('click', () => choisirMode('ldv'));
btnMesurer.addEventListener('click', () => choisirMode('mesurer'));

prendreLeClic((e, souris) => {
    if (!modeClic && !regard) return false;
    const p = solSous(souris);
    if (!p) return true;
    const gene = empechement();
    if (gene) { note.textContent = gene; return true; }
    if (regard || modeClic === 'ldv') {
        if (!poste) { note.textContent = 'Pose d’abord le poste.'; return true; }
        cible = p;
        afficherLigneDeVue();
    } else if (modeClic === 'poser') {
        poste = p;
        choisirMode('poser');           // un poste à la fois : le mode retombe
        for (const b of [btnVues, btnVu, btnRegard]) b.disabled = false;
        recalculer();
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

/** Tout ce qui dépend du poste et des hauteurs, recalculé. */
function recalculer() {
    if (!poste) return;
    const h = hauteurs();
    placer(marqueurPoste, poste, h.optiqueMoi);
    if (regard) marqueurPoste.visible = false;
    if (cible) afficherLigneDeVue();
    else {
        resultat.innerHTML = lignePoint('poste', poste);
        note.textContent = 'Poste posé. « Ligne de vue » puis un clic : ce que le poste voit de ce point.';
    }
    if (carte) dessinerCarte();
    if (regard) appliquerRegard();
}

// --- Ligne de vue et profil -----------------------------------------------------------

function afficherLigneDeVue() {
    const h = hauteurs();
    placer(marqueurCible, cible, h.optiqueLui);
    // Je le vois : de mon optique à son point exposé. Il me voit : de son
    // optique à mon point exposé.
    const jeVois = premierObstacle(enHaut(poste, h.optiqueMoi), enHaut(cible, h.expoLui));
    const ilVoit = premierObstacle(enHaut(cible, h.optiqueLui), enHaut(poste, h.expoMoi));
    const de = enHaut(poste, h.optiqueMoi), vers = enHaut(cible, h.expoLui);
    if (jeVois) {
        tracer('ldv', [de, jeVois.point], VERT);
        tracer('ldv-masque', [jeVois.point, vers], ROUGE);
    } else {
        tracer('ldv', [de, vers], VERT);
        effacerTrait('ldv-masque');
    }
    const dit = (o, vu) => o ? `non, masqué par ${o.nature} à ${fmt(o.distance)} m` : vu;
    resultat.innerHTML = lignePoint('poste', poste) + lignePoint('point visé', cible) + lignesMesure(poste, cible)
        + ligneStat('je le vois', dit(jeVois, 'oui'), jeVois ? 'masque' : 'vu')
        + ligneStat('il me voit', dit(ilVoit, 'oui'), ilVoit ? 'masque' : 'vu');
    const portee = mesure(poste, cible).horizontale;
    note.textContent = portee > h.portee
        ? `Au-delà de la portée saisie (${fmt(h.portee)} m).`
        : 'Profil : le sol en gris, la ligne de visée en vert, rouge après l’obstacle.';
    dessinerProfil(h, jeVois);
}

/** Le profil du sol du poste au point visé, et la ligne de visée. */
function dessinerProfil(h, obstacle) {
    profil.hidden = false;
    const ctx = profil.getContext('2d');
    const r = window.devicePixelRatio || 1;
    const W = profil.clientWidth || 300, H = profil.clientHeight || 110;
    profil.width = W * r; profil.height = H * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const N = 200, L = Math.hypot(cible.x - poste.x, cible.z - poste.z);
    const sol = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p = pointAuSol(poste.x + (cible.x - poste.x) * t, poste.z + (cible.z - poste.z) * t);
        sol.push(p ? p.y : NaN);
    }
    const yA = poste.y + h.optiqueMoi, yB = cible.y + h.expoLui;
    const valeurs = sol.filter(Number.isFinite).concat([yA, yB]);
    let bas = Math.min(...valeurs), haut = Math.max(...valeurs);
    const marge = Math.max(2, (haut - bas) * 0.15);
    bas -= marge; haut += marge;
    const X = d => 8 + (W - 16) * d / L, Y = y => H - 16 - (H - 24) * (y - bas) / (haut - bas);
    ctx.fillStyle = 'rgba(160,160,160,.45)';
    ctx.beginPath();
    ctx.moveTo(X(0), H - 16);
    sol.forEach((y, i) => { if (Number.isFinite(y)) ctx.lineTo(X(L * i / N), Y(y)); });
    ctx.lineTo(X(L), H - 16);
    ctx.closePath();
    ctx.fill();
    const coupe = obstacle ? obstacle.distance / Math.hypot(L, yB - yA) : 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4cc26b';
    ctx.beginPath(); ctx.moveTo(X(0), Y(yA)); ctx.lineTo(X(L * coupe), Y(yA + (yB - yA) * coupe)); ctx.stroke();
    if (obstacle) {
        ctx.strokeStyle = '#e5534b';
        ctx.beginPath(); ctx.moveTo(X(L * coupe), Y(yA + (yB - yA) * coupe)); ctx.lineTo(X(L), Y(yB)); ctx.stroke();
        ctx.fillStyle = '#e5534b';
        ctx.beginPath(); ctx.arc(X(L * coupe), Y(yA + (yB - yA) * coupe), 3, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.fillStyle = '#9aa4ae';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${fmt(altitude(haut - marge))} m`, 4, 10);
    ctx.fillText(`${fmt(altitude(bas + marge))} m`, 4, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt(L)} m`, W - 4, H - 4);
}

// --- Carte des vues -------------------------------------------------------------------
// Six faces de 2 048 px : 0,77 milliradian par pixel, 0,8 m à 1 km. Une
// grandeur flottante par pixel, 100 Mo de mémoire graphique. Le biais
// absorbe l'écart entre le sol et sa propre image dans la carte : 0,3 m plus
// 2 ‰ de la distance.
const TAILLE_CARTE = 2048;
const LOIN = 20000;
const COUCHE_CARTE = 7;
let cibleCube = null, cameraCube = null;
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
const matCarte = new THREE.ShaderMaterial({
    uniforms: {
        uDistances: { value: null }, uO: { value: new THREE.Vector3() }, uLoin: { value: LOIN },
        uHauteur: { value: 1 }, uPortee: { value: 1500 }, uQuiMeVoit: { value: 0 },
    },
    vertexShader: `varying vec3 vMonde;
void main() {
  vec4 m = modelMatrix * vec4(position, 1.0);
  vMonde = m.xyz;
  gl_Position = projectionMatrix * viewMatrix * m;
}`,
    fragmentShader: `uniform samplerCube uDistances;
uniform vec3 uO;
uniform float uLoin, uHauteur, uPortee, uQuiMeVoit;
varying vec3 vMonde;
void main() {
  vec3 d = vMonde + vec3(0.0, uHauteur, 0.0) - uO;
  float r = length(d.xz);
  if (r > uPortee) discard;
  float L = length(d);
  float libre = textureCube(uDistances, d).r * uLoin;
  bool vu = L <= libre + 0.3 + 0.002 * L;
  vec4 c;
  if (uQuiMeVoit > 0.5) c = vu ? vec4(0.90, 0.20, 0.18, 0.50) : vec4(0.20, 0.75, 0.35, 0.18);
  else c = vu ? vec4(0.20, 0.80, 0.35, 0.42) : vec4(0.85, 0.20, 0.18, 0.30);
  if (r > uPortee - 2.0 * fwidth(r) - 1.0) c = vec4(1.0, 1.0, 1.0, 0.9);
  gl_FragColor = c;
}`,
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
});
const calques = new THREE.Group();
calques.visible = false;
scene.add(calques);

/** Rend la carte des distances depuis O, sur les obstacles affichés. */
function rendreDistances(O) {
    if (!cibleCube) {
        cibleCube = new THREE.WebGLCubeRenderTarget(TAILLE_CARTE, {
            type: THREE.FloatType, format: THREE.RedFormat, generateMipmaps: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        cameraCube = new THREE.CubeCamera(0.05, LOIN, cibleCube);
        for (const c of cameraCube.children) c.layers.set(COUCHE_CARTE);
    }
    const objets = obstacles();
    for (const o of objets) o.layers.enable(COUCHE_CARTE);
    const avant = { fond: scene.background, matiere: scene.overrideMaterial, couleur: new THREE.Color(),
                    alpha: renderer.getClearAlpha(), ombres: renderer.shadowMap.autoUpdate };
    renderer.getClearColor(avant.couleur);
    scene.background = null;
    scene.overrideMaterial = matDistance;
    renderer.setClearColor(0xffffff, 1);          // rien dans cette direction : au plus loin
    renderer.shadowMap.autoUpdate = false;
    matDistance.uniforms.uO.value.copy(O);
    cameraCube.position.copy(O);
    cameraCube.updateMatrixWorld(true);
    try {
        cameraCube.update(renderer, scene);
    } finally {
        scene.background = avant.fond;
        scene.overrideMaterial = avant.matiere;
        renderer.setClearColor(avant.couleur, avant.alpha);
        renderer.shadowMap.autoUpdate = avant.ombres;
        for (const o of objets) o.layers.disable(COUCHE_CARTE);
    }
}

function dessinerCarte() {
    const gene = empechement();
    if (gene) { note.textContent = gene; return; }
    const h = hauteurs();
    // Ce que je vois : de mon optique vers son point exposé ; qui me voit :
    // de mon point exposé vers son optique.
    const O = enHaut(poste, carte === 'vues' ? h.optiqueMoi : h.expoMoi);
    rendreDistances(O);
    const u = matCarte.uniforms;
    u.uDistances.value = cibleCube.texture;
    u.uO.value.copy(O);
    u.uHauteur.value = carte === 'vues' ? h.expoLui : h.optiqueLui;
    u.uPortee.value = h.portee;
    u.uQuiMeVoit.value = carte === 'vu' ? 1 : 0;
    calques.clear();
    for (const s of sols()) {
        const m = new THREE.Mesh(s.geometry, matCarte);
        m.matrixAutoUpdate = false;
        s.updateMatrixWorld();
        m.matrix.copy(s.matrixWorld);
        m.renderOrder = 10;
        m.frustumCulled = false;
        calques.add(m);
    }
    calques.visible = true;
    legende.hidden = false;
    legende.innerHTML = carte === 'vues'
        ? `Ce que je vois, cible à ${fmt(h.expoLui, 1)} m :<i style="background:#33cc59"></i>vu<i style="background:#d9332e"></i>masqué`
        : `Qui me voit, œil à ${fmt(h.optiqueLui, 1)} m :<i style="background:#e6332e"></i>me voit<i style="background:#33bf59"></i>ne me voit pas`;
    note.textContent = `Calculé sur ${fmt(h.portee)} m autour du poste, avec ce qui est affiché `
        + '(relief, bâtiments, végétation). À recalculer si tu masques ou rallumes une couche.';
}

const legende = document.createElement('div');
legende.id = 'mi-legende';
legende.hidden = true;
host.appendChild(legende);

function choisirCarte(c) {
    carte = carte === c ? null : c;
    btnVues.classList.toggle('on', carte === 'vues');
    btnVu.classList.toggle('on', carte === 'vu');
    if (carte) dessinerCarte();
    else { calques.visible = false; legende.hidden = true; }
}
btnVues.addEventListener('click', () => choisirCarte('vues'));
btnVu.addEventListener('click', () => choisirCarte('vu'));
$('mi-portee').addEventListener('change', recalculer);

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
    const O = enHaut(poste, hauteurs().optiqueMoi);
    const c = Math.cos(regard.site);
    const dir = new THREE.Vector3(Math.sin(regard.cap) * c, Math.sin(regard.site), -Math.cos(regard.cap) * c);
    camera.position.copy(O);
    controls.target.copy(O).addScaledVector(dir, 30);
    camera.lookAt(controls.target);
    const grossissement = Math.tan(FOV_NU * Math.PI / 360) / Math.tan(camera.fov * Math.PI / 360);
    hud.textContent = `Az ${fmt(Math.round(azimutMilliemes(Math.sin(regard.cap), Math.cos(regard.cap))) % 6400)} ‰`
        + ` · site ${regard.site >= 0 ? '+' : ''}${fmt(regard.site * 3200 / Math.PI)} ‰`
        + ` · ×${fmt(grossissement, 1)} · glisser pour tourner, molette pour grossir, Échap pour sortir`;
}
function entrerRegard() {
    if (droneActif) { note.textContent = 'Sors du drone d’abord.'; return; }
    if (orbite) arreterOrbite();
    const vers = cible || { x: poste.x + (controls.target.x - camera.position.x),
                            z: poste.z + (controls.target.z - camera.position.z) };
    regard = {
        cap: Math.atan2(vers.x - poste.x, -(vers.z - poste.z)), site: 0,
        avant: { position: camera.position.clone(), cible: controls.target.clone(), fov: camera.fov,
                 polaire: controls.maxPolarAngle },
    };
    controls.enabled = false;
    controls.maxPolarAngle = Math.PI;
    marqueurPoste.visible = false;      // la caméra est dedans
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
    marqueurPoste.visible = true;
    btnRegard.classList.remove('on');
    reticule.hidden = hud.hidden = true;
}
btnRegard.addEventListener('click', () => { if (regard) sortirRegard(); else if (poste) entrerRegard(); });
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

remplirTypes($('mi-type-moi'), $('mi-optique-moi'), $('mi-expo-moi'), 4);
remplirTypes($('mi-type-lui'), $('mi-optique-lui'), $('mi-expo-lui'), 3);
note.textContent = NOTE_DEPART;

/** L'état du module, pour les essais. */
export const etatMission = () => ({ poste, cible, modeClic, carte, regard: !!regard });
