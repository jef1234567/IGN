// Les bâtiments d'un camp et de ses abords (`&vaste=1`) : batiments.json,
// rangé à côté de la page par horizon.yml (outils/paquet_horizon.py
// batiments) : l'emprise et la hauteur BD TOPO de chaque bâtiment, à 5 km
// autour du contour (27 085 autour de Canjuers, 3,1 Mo, 0,8 Mo compressé).
// Des prismes sans la végétation : vus de 15 km, les villages ressortent. Les
// calculs de vue (mission.js) les prennent comme obstacles.
//
// Rangés par carrés de 1 km : un rayon des calculs de vue ne teste que les
// carrés qu'il traverse (sphère englobante), pas les 600 000 triangles.
import * as THREE from 'three';
import { toLocal } from '../socle/projection.js';
import { scene } from '../socle/rendu.js';
import { ySolPartout } from '../terrain/horizon.js';
import { VASTE } from './vaste.js';

const CARRE_M = 1000;
// Le pied descend sous le sol le plus bas que l'horizon donne au centre :
// sur une pente de 30 %, un bâtiment de 10 m de large a 3 m d'écart.
const ENFOUI_M = 3;

export const groupeBatiCamp = new THREE.Group();
groupeBatiCamp.name = 'batiments-camp';
const materiau = new THREE.MeshStandardMaterial({ color: 0xd9cbb3, roughness: 0.9, side: THREE.DoubleSide });
const carres = [];   // { mesh, qui: Int32Array, haut: Uint8Array, batis: [{ lon, lat, h, y }] }

/** Les prismes d'un carré : murs et toit plat, sommets sans indices (normales franches). */
function construire(batis) {
    const pos = [], qui = [], haut = [];
    batis.forEach((b, i) => {
        // Sens horaire dans le plan (x, z) : la normale du mur (bas a, bas b,
        // haut b) regarde alors dehors, où mission.js écarte l'œil d'une façade.
        let aire = 0;
        b.xz.forEach(([x, z], k) => { const [u, w] = b.xz[(k + 1) % b.xz.length]; aire += x * w - u * z; });
        const pts = aire > 0 ? [...b.xz].reverse() : b.xz, n = pts.length;
        for (let k = 0; k < n; k++) {
            const [ax, az] = pts[k], [bx, bz] = pts[(k + 1) % n];
            // Deux triangles par mur : bas a, bas b, haut b ; bas a, haut b, haut a.
            for (const [x, z, t] of [[ax, az, 0], [bx, bz, 0], [bx, bz, 1], [ax, az, 0], [bx, bz, 1], [ax, az, 1]]) {
                pos.push(x, 0, z); qui.push(i); haut.push(t);
            }
        }
        const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
        for (const tri of THREE.ShapeUtils.triangulateShape(contour, [])) {
            for (const k of tri) { pos.push(pts[k][0], 0, pts[k][1]); qui.push(i); haut.push(1); }
        }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    const mesh = new THREE.Mesh(geo, materiau);
    const quiDe = Int32Array.from(qui);
    // Le haut du bâtiment d'un sommet touché : mission.js en tire le nombre
    // d'étages d'une façade, que la boîte du carré entier exagérerait.
    mesh.userData.hautDe = v => { const b = batis[quiDe[v]]; return (b.y ?? 0) + b.h; };
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    groupeBatiCamp.add(mesh);
    carres.push({ mesh, qui: quiDe, haut: Uint8Array.from(haut), batis });
}

/** Le sol sous chaque bâtiment relu : l'horizon se précise tuile après tuile. */
function poser() {
    for (const c of carres) {
        let change = false;
        for (const b of c.batis) {
            const y = ySolPartout(b.lon, b.lat);
            if (y != null && (b.y === null || Math.abs(y - b.y) > 0.2)) { b.y = y; change = true; }
        }
        if (!change) continue;
        const p = c.mesh.geometry.attributes.position;
        for (let v = 0; v < c.qui.length; v++) {
            const b = c.batis[c.qui[v]], sol = b.y ?? 0;
            p.setY(v, c.haut[v] ? sol + b.h : sol - ENFOUI_M);
        }
        p.needsUpdate = true;
        // Les murs restent verticaux : leurs normales ne changent pas d'un
        // déplacement en hauteur, seules les premières sont à calculer.
        if (!c.mesh.geometry.attributes.normal) c.mesh.geometry.computeVertexNormals();
        c.mesh.geometry.computeBoundingSphere();
        c.mesh.geometry.computeBoundingBox();
    }
}

async function charger() {
    const r = await fetch('batiments.json');
    if (!r.ok) return;          // un camp publié sans bâtiments
    const { batiments } = await r.json();
    const parCarre = new Map();
    for (const b of batiments) {
        const xz = [];
        let sx = 0, sz = 0;
        for (let k = 1; k + 1 < b.length; k += 2) {
            const [x, y] = toLocal(b[k], b[k + 1]);
            xz.push([x, -y]); sx += b[k]; sz += b[k + 1];
        }
        const n = xz.length;
        const lon = sx / n, lat = sz / n;
        const [cx, cy] = toLocal(lon, lat);
        const cle = `${Math.floor(cx / CARRE_M)},${Math.floor(cy / CARRE_M)}`;
        if (!parCarre.has(cle)) parCarre.set(cle, []);
        parCarre.get(cle).push({ xz, lon, lat, h: b[0], y: null });
    }
    for (const batis of parCarre.values()) construire(batis);
    scene.add(groupeBatiCamp);
    poser();
    setInterval(poser, 2000);
    const bouton = document.createElement('button');
    bouton.className = 'toggle on';
    bouton.id = 't-bati-camp';
    bouton.textContent = 'Bâtiments';
    bouton.title = 'Bâtiments BD TOPO du camp et de ses abords, à leur hauteur ; obstacles des calculs de vue';
    bouton.addEventListener('click', () => { groupeBatiCamp.visible = bouton.classList.toggle('on'); });
    (document.getElementById('t-reperes') || document.getElementById('t-horizon')).after(bouton);
}

// Sans await au niveau du module : les modules suivants attendraient le fichier.
if (VASTE) charger().catch(e => console.warn('bâtiments du camp :', e));
