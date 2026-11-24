// Les bâtiments, état partagé : matériaux, groupe et maillages, toitures et
// monuments reçus, choix d'affichage, bâtiment visé.

import * as THREE from 'three';
import { scene } from '../socle/rendu.js';

export const MAT_CIBLE = new THREE.MeshStandardMaterial({ color: 0xc9a88a, roughness: 0.8, flatShading: true });
export const MAT_CONTOUR_CIBLE = new THREE.LineBasicMaterial({ color: 0xff8a00 });
export const MAT_VOISIN   = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.85, flatShading: true });
export const MAT_TOIT_VOISIN = new THREE.MeshStandardMaterial({ color: 0x6f7883, roughness: 0.9, flatShading: true });
// Surface mesurée : ombrage lissé par les normales pliées (geometriesSurface),
// que flatShading ignorerait.
export const MAT_TOIT_SURFACE = new THREE.MeshStandardMaterial({ color: 0x6f7883, roughness: 0.9 });
// Hauteur inconnue (bâtiment sous les arbres) : volume pâle et translucide,
// pour dire « on sait qu'il y a un bâtiment, pas sa hauteur ».
export const MAT_INCONNU = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.9, flatShading: true,
                                                            transparent: true, opacity: 0.55 });
// Dessus plat : juste au-dessus de la face haute des murs, qu'il recouvre, et
// tiré vers la caméra pour ne pas scintiller avec elle au loin.
export const DESSUS_DECALAGE = 0.05;
export const DECALAGE_DESSUS = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
export const MAT_DESSUS = new THREE.MeshStandardMaterial({ color: 0x6f7883, roughness: 0.9, ...DECALAGE_DESSUS });

export const groupeBatiments = new THREE.Group();
scene.add(groupeBatiments);
export const meshes = [];
// Suivis à part : ce sont les seules faces sur lesquelles on plaque la photo
// aérienne, une projection nadir n'ayant pas de sens sur une façade verticale.
export const meshesToits = [];

// Toitures LiDAR par cleabs : {gouttiere, faitage, denivele, axe_deg, ...}.
// Rempli avant construire() — le rendu s'en sert en priorité sur la BD TOPO.
export let TOITS = {};
export let TOITS_SOURCE = null;
// Ce qui dit qu'un toit est sous les arbres : 'lidar_hd' (la carte des classes
// du nuage, scène v16, vue3d/classes.py) ou 'orthophoto' (son vert, avant).
export let TOITS_COUVERT = null;
// Grille MNH dont les surfaces de toit sont des fenêtres : { bbox, width, height }.
export let TOITS_GRILLE = null;
// Monuments OSM : { parties, remplaces } ou null (vue3d/monuments.py). Dessinés
// d'office quand la scène en a — c'est la seule source qui sache la forme d'un
// monument sans LiDAR — et débrayables par le bouton, qui n'apparaît qu'alors.
export let MONUMENTS = null;
export let monumentsActifs = true;
// Les choix d'affichage, à leurs boutons (interface/boutons). Les toits
// mesurés sont allumés au départ depuis les toits en pans : ils sont aussi
// nets que le toit résumé et plus justes, là où il s'écarte du LiDAR. Il ne
// touche que ces toits-là ; seule la surface de repli, sur un toit qui n'est
// pas fait de plans, garde le grain du LiDAR.
export let toitsEnPente = true;
export let toitsMesures = true;
// Le bâtiment du point (batiments/cible) : { anneau, p, distance } ; distance
// 0 : le point est dedans.
export let CIBLE = null;

/** Les toitures de la scène : { toits, source, grille }. */
export function poserToits(toits) {
    TOITS = toits.toits; TOITS_SOURCE = toits.source; TOITS_GRILLE = toits.grille || null;
    TOITS_COUVERT = toits.couvert || (toits.ortho ? 'orthophoto' : null);
}
export function poserMonuments(m) { MONUMENTS = m; }
export function basculerMonuments() { monumentsActifs = !monumentsActifs; }
export function basculerToitsEnPente() { toitsEnPente = !toitsEnPente; }
export function basculerToitsMesures() { toitsMesures = !toitsMesures; }
export function poserCible(c) { CIBLE = c; }

// La construction des bâtiments vient après les couches qu'elle consulte
// (batiments/construction) : celles qui changent ce qu'elle dessine la
// redemandent par ici.
let redessin = () => {};
export function poserRedessinDesBatiments(fn) { redessin = fn; }
/** Les bâtiments reconstruits, et la fiche du bâtiment visé avec eux. */
export function redessinerBatiments() { redessin(); }

// Façades : fenêtres et étages dessinés par le shader sur les faces verticales
// (étage de 3 m, travée de 3,2 m), sans UV ni texture. Repère monde : les
// lignes d'étage suivent l'altitude, les travées la longueur du mur.
function ajouterFacades(materiau, teinteMur) {
    materiau.onBeforeCompile = shader => {
        shader.vertexShader = 'varying vec3 vPosFacade;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nvPosFacade = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = 'varying vec3 vPosFacade;\n' + shader.fragmentShader.replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            {
                vec3 nF = normalize(cross(dFdx(vPosFacade), dFdy(vPosFacade)));
                if (abs(nF.y) < 0.25) {
                    vec2 tg = normalize(vec2(-nF.z, nF.x));
                    float u = dot(vPosFacade.xz, tg) / 3.2;
                    float v = vPosFacade.y / 3.0;
                    vec2 f = fract(vec2(u, v));
                    vec3 mur = ${teinteMur};
                    // bandeau d'étage
                    if (f.y < 0.04) mur *= 0.82;
                    // fenêtre et son encadrement
                    float dansF = step(0.30, f.x) * step(f.x, 0.70) * step(0.28, f.y) * step(f.y, 0.78);
                    float cadre = step(0.27, f.x) * step(f.x, 0.73) * step(0.25, f.y) * step(f.y, 0.81) - dansF;
                    vec3 vitre = mix(vec3(0.16, 0.20, 0.25), vec3(0.30, 0.36, 0.42), f.y);
                    mur = mix(mur, vec3(0.93), cadre);
                    mur = mix(mur, vitre, dansF);
                    diffuseColor.rgb = mur;
                }
            }`);
    };
    materiau.customProgramCacheKey = () => 'facades-' + teinteMur;
}
ajouterFacades(MAT_VOISIN, 'vec3(0.86, 0.84, 0.79)');
ajouterFacades(MAT_CIBLE, 'vec3(0.84, 0.70, 0.58)');
