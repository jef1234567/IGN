// La navigation sur tout un camp (`&vaste=1`, posé par figer.mjs pour un camp
// publié par horizon.yml) : glisser déplace le point visé sur le sol, la
// molette monte jusqu'à VASTE_RECUL_MAX et redescend vers le curseur. Sans
// elle, l'orbite ne s'éloigne pas à plus de 900 m × ECHELLE_ZONE du point
// visé, qui reste à l'altitude du centre : à 20 km, sur un plateau 300 m plus
// haut, la caméra passait sous le relief.
import * as THREE from 'three';
import { toLonLat } from '../socle/projection.js';
import { camera, controls, brumeHorizon } from '../socle/rendu.js';
import { ySolPartout } from '../terrain/horizon.js';
import { aideVue } from './decalage.js';

export const VASTE = new URLSearchParams(location.search).get('vaste') === '1';

// 30 km de recul : tout le camp de Canjuers (35 × 15 km) tient à l'écran.
const VASTE_RECUL_MAX = 30000;
// Le point visé reste à moins de 40 km du centre : l'horizon s'arrête à 60 km.
const VASTE_RAYON = 40000;
// La caméra garde 20 m au-dessus de ce qu'elle survole.
const VASTE_GARDE = 20;
// La brume de l'horizon (4e-5 par mètre) blanchit tout au-delà de 25 km :
// elle s'éclaircit au-dessus de 1 500 m de recul, pour voir le camp d'en haut.
const BRUME = brumeHorizon.density;
const BRUME_RECUL = 1500;

if (VASTE) {
    controls.maxDistance = VASTE_RECUL_MAX;
    controls.screenSpacePanning = false;    // glisser suit le sol, pas l'écran
    controls.zoomToCursor = true;
    // Glisser déplace, comme sur une carte ; le clic droit (deux doigts)
    // pivote. Placé avant drone.js, qui garde cette aide pour la rendre en
    // sortant du drone.
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    aideVue.textContent = matchMedia('(pointer: coarse)').matches
        ? 'Glisser pour se déplacer · deux doigts pour zoomer et pivoter'
        : 'Glisser pour se déplacer · clic droit pour pivoter · molette pour zoomer vers le curseur';
}

/** Une image : le point visé suit le relief, la caméra reste au-dessus. */
export function majVaste() {
    if (!VASTE) return;
    const t = controls.target;
    const r = Math.hypot(t.x, t.z);
    if (r > VASTE_RAYON) {
        const k = VASTE_RAYON / r;
        camera.position.x -= t.x * (1 - k); camera.position.z -= t.z * (1 - k);
        t.x *= k; t.z *= k;
    }
    const [lon, lat] = toLonLat(t.x, -t.z);
    const sol = ySolPartout(lon, lat);
    if (sol != null && Number.isFinite(sol)) {
        // Rejoint en quelques images : une tuile plus fine qui arrive ne fait
        // pas sauter la vue.
        const dy = (sol - t.y) * 0.2;
        t.y += dy; camera.position.y += dy;
    }
    const [clon, clat] = toLonLat(camera.position.x, -camera.position.z);
    const dessous = ySolPartout(clon, clat);
    if (dessous != null && camera.position.y < dessous + VASTE_GARDE) {
        camera.position.y = dessous + VASTE_GARDE;
    }
    const recul = camera.position.distanceTo(t);
    brumeHorizon.density = BRUME * Math.min(1, BRUME_RECUL / recul);
}
