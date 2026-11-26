// Le pourtour du camp et ses repères (`&vaste=1`) : vu de 15 km, un camp de
// 35 km sans un nom ne se lit pas. Deux fichiers rangés à côté de la page par
// horizon.yml : camp.geojson, le contour (zones/<camp>.geojson), et
// reperes.geojson (outils/paquet_horizon.py reperes) : villages, lieux-dits,
// sommets et routes départementales d'OpenStreetMap, à 5 km autour.
//
// Tout est posé sur ySolPartout, relu toutes les 2 s : l'horizon arrive tuile
// après tuile, et un point posé avant la sienne resterait à 0 m.
import * as THREE from 'three';
import { toLocal } from '../socle/projection.js';
import { scene, camera, renderer } from '../socle/rendu.js';
import { ySolPartout } from '../terrain/horizon.js';
import { citerSource, majCredits } from './credits.js';
import { VASTE } from './vaste.js';

// Le contour est repris tous les 50 m : entre deux sommets OSM espacés de
// plusieurs centaines de mètres, une ligne droite passerait sous les crêtes.
const PAS_CONTOUR_M = 50;
const AU_DESSUS_CONTOUR_M = 15;
const AU_DESSUS_ROUTE_M = 6;
// Une étiquette n'est montrée qu'en deçà de sa distance à la caméra : les
// villages de partout, un lieu-dit seulement d'assez près pour qu'il ne
// recouvre pas ses voisins (environ 2 km entre deux lieux-dits du plateau).
const PORTEE_M = {
    city: 80000, town: 80000, village: 60000, hamlet: 9000,
    isolated_dwelling: 5000, locality: 7000, sommet: 12000, route: 14000,
};
const TAILLE_PX = { city: 17, town: 16, village: 15, route: 12 };
// Le numéro d'une route est répété tous les 3 km le long de son tracé.
const PAS_ETIQUETTE_ROUTE_M = 3000;

const groupe = new THREE.Group();
groupe.name = 'reperes';
groupe.visible = false;
const lignes = [];       // { objet, lonlat: [[lon, lat]…], dessus }
const etiquettes = [];   // { sprite, lon, lat, portee, px, ratio }
const pasDeRayon = () => {};

/** Une étiquette dessinée une fois sur un canevas, à taille fixe à l'écran. */
function etiquette(texte, couleur, px) {
    const echelle = 2;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const police = `600 ${px * echelle}px system-ui, sans-serif`;
    ctx.font = police;
    const l = Math.ceil(ctx.measureText(texte).width) + 8 * echelle, h = Math.ceil(px * 1.5 * echelle);
    c.width = l; c.height = h;
    ctx.font = police;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4 * echelle;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(texte, 4 * echelle, h / 2);
    ctx.fillStyle = couleur;
    ctx.fillText(texte, 4 * echelle, h / 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: t, sizeAttenuation: false, depthTest: false, transparent: true,
    }));
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 10;
    sprite.raycast = pasDeRayon;
    return { sprite, ratio: l / h, hauteurPx: h / echelle };
}

/** Une ligne au sol : visible devant le relief, plus pâle derrière. */
function ligne(lonlat, couleur, dessus) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lonlat.length * 3), 3));
    const devant = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: couleur }));
    const derriere = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: couleur, transparent: true, opacity: 0.35, depthTest: false,
    }));
    devant.raycast = derriere.raycast = pasDeRayon;
    devant.frustumCulled = derriere.frustumCulled = false;
    groupe.add(devant, derriere);
    lignes.push({ geo, lonlat, dessus });
}

/** L'anneau repris tous les PAS_CONTOUR_M mètres. */
function densifier(anneau) {
    const sortie = [];
    for (let i = 0; i + 1 < anneau.length; i++) {
        const [a, b] = [toLocal(...anneau[i]), toLocal(...anneau[i + 1])];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / PAS_CONTOUR_M));
        for (let k = 0; k < n; k++) {
            const f = k / n;
            sortie.push([anneau[i][0] + (anneau[i + 1][0] - anneau[i][0]) * f,
                         anneau[i][1] + (anneau[i + 1][1] - anneau[i][1]) * f]);
        }
    }
    sortie.push(anneau[anneau.length - 1]);
    return sortie;
}

function anneaux(geometrie) {
    if (geometrie.type === 'Polygon') return geometrie.coordinates;
    if (geometrie.type === 'MultiPolygon') return geometrie.coordinates.flat();
    return [];
}

function ajouterEtiquette(texte, couleur, genre, lon, lat) {
    const px = TAILLE_PX[genre] || 13;
    const e = etiquette(texte, couleur, px);
    groupe.add(e.sprite);
    etiquettes.push({ ...e, lon, lat, portee: PORTEE_M[genre] || 8000 });
}

function poserCamp(geojson) {
    const g = geojson.geometry || geojson;
    for (const a of anneaux(g)) ligne(densifier(a), 0xff453a, AU_DESSUS_CONTOUR_M);
    const nom = geojson.properties && geojson.properties.nom;
    if (nom && g.type === 'Polygon') {
        // Le nom du camp au point le plus au nord de son contour, lu de loin.
        const nord = g.coordinates[0].reduce((m, p) => (p[1] > m[1] ? p : m));
        const e = etiquette(nom, '#ff8a80', 15);
        groupe.add(e.sprite);
        etiquettes.push({ ...e, lon: nord[0], lat: nord[1], portee: 80000 });
    }
}

function poserReperes(fc) {
    const vus = new Map();    // ref → points [x, y] déjà étiquetés
    for (const f of fc.features || []) {
        const p = f.properties || {};
        if (f.geometry.type === 'Point') {
            const [lon, lat] = f.geometry.coordinates;
            const texte = p.type === 'sommet' && p.ele ? `▲ ${p.nom} ${Math.round(Number(p.ele))} m` : p.nom;
            const couleur = p.type === 'sommet' ? '#d7c4a3' : (PORTEE_M[p.type] > 20000 ? '#ffffff' : '#e8eef5');
            ajouterEtiquette(texte, couleur, p.type, lon, lat);
        } else if (f.geometry.type === 'LineString' && p.ref) {
            const c = f.geometry.coordinates;
            ligne(c, 0xffd60a, AU_DESSUS_ROUTE_M);
            const deja = vus.get(p.ref) || [];
            const milieu = c[Math.floor(c.length / 2)];
            const [x, y] = toLocal(...milieu);
            if (deja.every(([u, v]) => Math.hypot(u - x, v - y) > PAS_ETIQUETTE_ROUTE_M)) {
                deja.push([x, y]);
                vus.set(p.ref, deja);
                ajouterEtiquette(p.ref, '#ffd60a', 'route', ...milieu);
            }
        }
    }
}

/** Relit l'altitude de tout ce qui est posé : l'horizon s'est peut-être précisé. */
function reposer() {
    for (const { geo, lonlat, dessus } of lignes) {
        const pos = geo.attributes.position;
        for (let i = 0; i < lonlat.length; i++) {
            const [x, y] = toLocal(...lonlat[i]);
            pos.setXYZ(i, x, (ySolPartout(...lonlat[i]) ?? 0) + dessus, -y);
        }
        pos.needsUpdate = true;
        geo.computeBoundingSphere();
    }
    for (const e of etiquettes) {
        const [x, y] = toLocal(e.lon, e.lat);
        e.sprite.position.set(x, (ySolPartout(e.lon, e.lat) ?? 0) + 25, -y);
    }
}

/** Taille à l'écran et étiquettes trop lointaines masquées. */
function majEtiquettes() {
    const h = renderer.domElement.clientHeight || 1;
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / h;
    for (const e of etiquettes) {
        e.sprite.visible = camera.position.distanceTo(e.sprite.position) < e.portee;
        e.sprite.scale.set(e.hauteurPx * e.ratio * k, e.hauteurPx * k, 1);
    }
}

async function lireJson(nom) {
    const r = await fetch(nom);
    if (!r.ok) throw new Error(`${nom} : HTTP ${r.status}`);
    return r.json();
}

// Sans await au niveau du module : les modules suivants (drone, boucle)
// attendraient ces fichiers pour s'évaluer.
if (VASTE) poser();

async function poser() {
    scene.add(groupe);
    // Sans ces fichiers (un camp publié avant eux), la page reste comme avant.
    const [camp, reperes] = await Promise.all([
        lireJson('camp.geojson').catch(() => null),
        lireJson('reperes.geojson').catch(() => null),
    ]);
    if (camp) poserCamp(camp);
    if (reperes) poserReperes(reperes);
    if (camp || reperes) {
        const bouton = document.createElement('button');
        bouton.className = 'toggle on';
        bouton.id = 't-reperes';
        bouton.textContent = 'Repères';
        bouton.title = 'Pourtour du camp, villages, lieux-dits, sommets et routes départementales (OpenStreetMap)';
        bouton.addEventListener('click', () => {
            groupe.visible = bouton.classList.toggle('on');
            majCredits();
        });
        document.getElementById('t-horizon').after(bouton);
        groupe.visible = true;
        citerSource('reperes', () => groupe.visible);
        majCredits();
        reposer();
        setInterval(reposer, 2000);
        setInterval(majEtiquettes, 200);
        majEtiquettes();
    }
}
