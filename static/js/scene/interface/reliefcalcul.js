// Le relief des calculs de vue au-delà de la scène et de son anneau.
//
// Sur un camp vaste (Canjuers : une scène de 150 m, un anneau de 2 km, puis
// l'horizon tuilé jusqu'à 60 km), la carte des vues, la ligne de vue et le
// bréchage ne voyaient que la scène et l'anneau : au-delà, le relief ne
// masquait rien. L'horizon affiché ne peut pas servir tel quel : sa finesse
// suit la caméra (une maille de 9 m sous elle, de 300 m à 15 km), et une
// ligne de vue changerait avec le point de vue de l'écran.
//
// Ce module tend donc, sur l'emprise d'un calcul, un maillage du RGE ALTI à
// un niveau fixe (celui de la tuile d'horizon la plus fine, que le paquet
// hors réseau garde partout), avec la même courbure de la Terre que
// l'horizon. Là où la scène ou l'anneau existent, il n'a pas de facette :
// leur relief, plus fin, reste seul. Il ne se dessine pas (ni couleur ni
// profondeur) mais se vise, masque, et porte le calque des vues.

import * as THREE from 'three';
import { scene } from '../socle/rendu.js';
import { toLonLat } from '../socle/projection.js';
import { terrain, anneauRelief, altitudeRef, exagVert, BORNES } from '../terrain/etat.js';
import { altitudesEmprise, ySolPartout, RAYON_TERRE_APPARENT } from '../terrain/horizon.js';

// 512 mailles de côté au plus : 525 000 triangles, qu'un rayon traverse en
// une trentaine de millisecondes sans arbre d'accélération. À 3 km de côté
// (un obstacle cherché à 1 500 m), 6 m par maille, plus fin que le niveau 12
// du RGE ALTI lu hors réseau (19 m) : le maillage suit ses pixels.
const MAILLES_MAX = 512;
const PAS_MIN = 5;              // m
const SANS = -1e5;

const materiau = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
let courant = null;             // { mesh, b, alt }

/** Vrai si la scène fine ou l'anneau portent ce point : leur relief y fait foi. */
function couvert(lon, lat) {
    if (terrain && lon >= BORNES.o && lon <= BORNES.e && lat >= BORNES.s && lat <= BORNES.n) return true;
    return !!anneauRelief && Number.isFinite(anneauRelief.alt(lon, lat));
}

/** Y de scène du relief de calcul en (x, z), courbure comprise ; null hors de lui. */
function yCalcul(alt, x, z) {
    const [lon, lat] = toLonLat(x, -z);
    const a = alt(lon, lat);
    if (!Number.isFinite(a)) return null;
    return (a - altitudeRef) * exagVert - (x * x + z * z) / (2 * RAYON_TERRE_APPARENT);
}

const contient = (a, b) => a.x0 <= b.x0 && a.x1 >= b.x1 && a.z0 <= b.z0 && a.z1 >= b.z1;

/**
 * Tend le relief de calcul sur l'emprise b ({ x0, x1, z0, z1 } de la scène) ;
 * rien à faire si le précédent la couvre. Rend son maillage, ou null si la
 * scène et l'anneau la couvrent entière. Lève si le RGE ALTI ne se lit pas.
 */
export async function reliefDeCalcul(b) {
    if (courant && contient(courant.b, b)) return courant.mesh;
    const coins = [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]].map(([x, z]) => toLonLat(x, -z));
    if (coins.every(([lon, lat]) => couvert(lon, lat))) return courant?.mesh ?? null;
    const lons = coins.map(c => c[0]), lats = coins.map(c => c[1]);
    const marge = 0.002;
    const alt = await altitudesEmprise(Math.min(...lons) - marge, Math.min(...lats) - marge,
                                       Math.max(...lons) + marge, Math.max(...lats) + marge);
    const cote = Math.max(b.x1 - b.x0, b.z1 - b.z0);
    const pas = Math.max(PAS_MIN, cote / MAILLES_MAX);
    const nx = Math.ceil((b.x1 - b.x0) / pas), nz = Math.ceil((b.z1 - b.z0) / pas);
    const L = nx + 1;
    const pos = new Float32Array(L * (nz + 1) * 3);
    for (let j = 0; j <= nz; j++) {
        for (let i = 0; i <= nx; i++) {
            const x = b.x0 + i * pas, z = b.z0 + j * pas, k = (j * L + i) * 3;
            const [lon, lat] = toLonLat(x, -z);
            const y = couvert(lon, lat) ? null : yCalcul(alt, x, z);
            pos[k] = x; pos[k + 1] = y ?? SANS; pos[k + 2] = z;
        }
    }
    const index = [];
    const ok = k => pos[k * 3 + 1] > SANS / 2;
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            const a = j * L + i, c = a + L;
            if (ok(a) && ok(c) && ok(a + 1)) index.push(a, c, a + 1);
            if (ok(c) && ok(c + 1) && ok(a + 1)) index.push(c, c + 1, a + 1);
        }
    }
    oter();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, materiau);
    mesh.userData.reliefCalcul = true;
    mesh.renderOrder = -1;
    scene.add(mesh);
    courant = { mesh, b: { ...b }, alt };
    return mesh;
}

function oter() {
    if (!courant) return;
    scene.remove(courant.mesh);
    courant.mesh.geometry.dispose();
    courant = null;
}

/** Vrai si le relief de calcul, ou la scène et l'anneau, couvrent l'emprise b. */
export function reliefCouvre(b) {
    if (courant && contient(courant.b, b)) return true;
    return [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]].every(([x, z]) => couvert(...toLonLat(x, -z)));
}

/** Le maillage en place, ou null. */
export const maillageCalcul = () => courant?.mesh ?? null;

/**
 * Y du sol en (lon, lat) pour les calculs : la scène ou l'anneau là où ils
 * sont, sinon le relief de calcul s'il couvre ce point, sinon l'horizon
 * affiché (ySolPartout) ; null si rien n'y est chargé.
 */
export function ySolCalcul(lon, lat, x, z) {
    if (!couvert(lon, lat) && courant && x >= courant.b.x0 && x <= courant.b.x1
        && z >= courant.b.z0 && z <= courant.b.z1) {
        const y = yCalcul(courant.alt, x, z);
        if (y != null) return y;
    }
    return ySolPartout(lon, lat);
}

/**
 * Ce que la courbure de la Terre retranche à l'Y de scène en (x, z) : nul sur
 * la scène et l'anneau, plats ; au-delà, sur le relief de calcul comme sur
 * l'horizon, (x² + z²) / 2R'. Une altitude affichée le rajoute.
 */
export function chute(lon, lat, x, z) {
    return couvert(lon, lat) ? 0 : (x * x + z * z) / (2 * RAYON_TERRE_APPARENT);
}
