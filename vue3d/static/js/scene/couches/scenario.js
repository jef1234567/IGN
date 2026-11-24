// Calque scénario : un scenario.json (outils/scenario.py, depuis le tableur)
// rejoué sur une frise. Le temps de la frise règle le soleil et les effets ;
// cette première étape dessine les fumigènes, les autres types du format
// (explosion, incendie, unité, nuit) sont déjà placés sur la frise.
//
//   ?…&scenario=scenario.json      chemin relatif à la page
//
// Chaque effet est une fonction du temps de la frise, sans état : reculer,
// sauter à un événement ou accélérer rend la même image qu'en lecture.

import * as THREE from 'three';
import { scene, soleil, camera, renderer } from '../socle/rendu.js';
import { toLocal } from '../socle/projection.js';
import { ySol } from '../terrain/etat.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { etatCouche } from '../interface/etat-couche.js';

const FORMAT = 'scenario-cenzub';
const VERSION = 1;
const SOURCE = new URLSearchParams(location.search).get('scenario');

const COULEURS = {
    blanc: 0xe6e6e2, rouge: 0xd0402e, vert: 0x46a752, jaune: 0xe2c43a,
    violet: 0x8a52c2, orange: 0xec8a2c, noir: 0x2c2c2c,
};

// --- Fumigène -----------------------------------------------------------------
// Un rendu d'aspect, pas un modèle physique : des bouffées émises à cadence
// fixe, portées par le vent, qui montent, s'élargissent et s'effacent. Une
// bouffée vit DUREE_BOUFFEE_S ; le panache fait donc vent × 45 s de long
// (135 m à 3 m/s), sa largeur suit la taille saisie au tableur.
const BOUFFEES = 140;
const DUREE_BOUFFEE_S = 45;

function texturePanache() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const d = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    d.addColorStop(0, 'rgba(255,255,255,1)');
    d.addColorStop(0.45, 'rgba(255,255,255,.55)');
    d.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = d;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
const TEXTURE = texturePanache();

function materiauFumee(couleur) {
    return new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
            couleur: { value: new THREE.Color(couleur) },
            carte: { value: TEXTURE },
            lumiere: { value: 1 },
            echelle: { value: 500 },
        }]),
        vertexShader: `attribute float aTaille;
attribute float aAlpha;
uniform float echelle;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aTaille * echelle / -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
        fragmentShader: `uniform vec3 couleur;
uniform sampler2D carte;
uniform float lumiere;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(carte, gl_PointCoord).a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(couleur * lumiere, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
        transparent: true, depthWrite: false, fog: true,
    });
}

// Hasard reproductible d'une bouffée : la même à chaque passage de la frise.
function hasard(i, k, n) {
    const x = Math.sin(i * 127.1 + k * 311.7 + n * 74.7) * 43758.5453;
    return x - Math.floor(x);
}

function creerFumigene(ev, ventScenario) {
    const p = ev.params || {};
    const taille = p.taille_m || 15;
    const de = p.vent_d_ou ?? ventScenario.de;
    const vitesse = p.vent_m_s ?? ventScenario.vitesse;
    // Le vent souffle VERS de + 180° ; nord -Z, est +X.
    const vers = (de + 180) * Math.PI / 180;
    const vent = new THREE.Vector3(Math.sin(vers), 0, -Math.cos(vers)).multiplyScalar(vitesse);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOUFFEES * 3), 3));
    geo.setAttribute('aTaille', new THREE.BufferAttribute(new Float32Array(BOUFFEES), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(BOUFFEES), 1));
    const points = new THREE.Points(geo, materiauFumee(COULEURS[p.couleur] ?? COULEURS.blanc));
    points.frustumCulled = false;
    points.visible = false;
    const [x, y] = toLocal(ev.lon, ev.lat);
    points.position.set(x, 0, -y);
    const pas = DUREE_BOUFFEE_S / BOUFFEES;
    return {
        ev, objet: points,
        placer() { points.position.y = ySol(ev.lon, ev.lat); },
        maj(t) {
            const actif = t >= ev.debut && t <= ev.fin + DUREE_BOUFFEE_S;
            points.visible = actif;
            if (!actif) return;
            const pos = geo.attributes.position.array, tl = geo.attributes.aTaille.array,
                  al = geo.attributes.aAlpha.array;
            for (let i = 0; i < BOUFFEES; i++) {
                // La bouffée i naît à debut + i·pas + k·DUREE ; seule la
                // dernière née avant t peut encore être en vie.
                const k = Math.floor((t - ev.debut - i * pas) / DUREE_BOUFFEE_S);
                const naissance = ev.debut + i * pas + k * DUREE_BOUFFEE_S;
                const age = t - naissance;
                if (k < 0 || naissance > ev.fin) { al[i] = 0; continue; }
                const f = age / DUREE_BOUFFEE_S;
                const r = 0.5 + taille * 0.45 * Math.sqrt(f);
                const ang = hasard(i, k, 1) * 2 * Math.PI, rad = r * Math.sqrt(hasard(i, k, 2));
                const monte = taille * 0.7 * (1 - Math.exp(-age / 12)) + hasard(i, k, 3) * r * 0.5;
                pos[3 * i] = vent.x * age + Math.cos(ang) * rad;
                pos[3 * i + 1] = 0.5 + monte;
                pos[3 * i + 2] = vent.z * age + Math.sin(ang) * rad;
                tl[i] = 1.5 + taille * 0.9 * Math.sqrt(f);
                al[i] = 0.6 * Math.min(1, age / 1.5) * Math.pow(1 - f, 1.5);
            }
            geo.attributes.position.needsUpdate = true;
            geo.attributes.aTaille.needsUpdate = true;
            geo.attributes.aAlpha.needsUpdate = true;
            // Taille des points en pixels : mètres × hauteur du tampon / (2 tan(fov/2)) / distance.
            points.material.uniforms.echelle.value = renderer.domElement.height
                / (2 * Math.tan(camera.fov * Math.PI / 360));
            // La fumée n'émet pas : elle s'assombrit avec le jour.
            points.material.uniforms.lumiere.value = 0.22 + 0.78 * Math.min(1, soleil.intensity / 2);
        },
    };
}

const FABRIQUES = { fumigene: creerFumigene };

// --- Frise --------------------------------------------------------------------
const groupe = new THREE.Group();
groupe.name = 'scenario';
scene.add(groupe);

const frise = document.getElementById('frise');
const curseur = document.getElementById('frise-curseur');
const lecture = document.getElementById('frise-lecture');
const choixVitesse = document.getElementById('frise-vitesse');
const affHeure = document.getElementById('frise-heure');
const reperes = document.getElementById('frise-reperes');
const bouton = document.getElementById('t-scenario');
const curseurHeure = document.getElementById('heure');
const curseurSaison = document.getElementById('saison');

let scenario = null;
let effets = [];
let temps = 0;
let enLecture = false;
let minuteSoleil = null;

const texteHeure = s => {
    const j = Math.floor(s / 86400), r = ((s % 86400) + 86400) % 86400;
    return `${String(Math.floor(r / 3600)).padStart(2, '0')}:${String(Math.floor(r / 60) % 60).padStart(2, '0')}`
        + `:${String(Math.floor(r) % 60).padStart(2, '0')}${j > 0 ? ' (J+1)' : ''}`;
};

function jourDeLAnnee(iso) {
    const [a, m, j] = iso.split('-').map(Number);
    return Math.round((Date.UTC(a, m - 1, j) - Date.UTC(a, 0, 1)) / 86400000) + 1;
}

/** Le soleil suit la frise, par les curseurs de son module (interface/soleil). */
function reglerSoleil() {
    const minute = Math.floor(temps / 60);
    if (minute === minuteSoleil) return;
    minuteSoleil = minute;
    curseurHeure.value = ((temps / 3600) % 24).toFixed(2);
    curseurHeure.dispatchEvent(new Event('input'));
}

function allerA(t) {
    temps = Math.min(Math.max(t, scenario.debut), scenario.fin);
    curseur.value = temps;
    affHeure.textContent = texteHeure(temps);
    const visible = bouton.classList.contains('on');
    for (const e of effets) e.maj(visible ? temps : -Infinity);
    for (const r of reperes.children) r.classList.toggle('passe', Number(r.dataset.t) <= temps);
    reglerSoleil();
}

function poserReperes() {
    reperes.textContent = '';
    const duree = scenario.fin - scenario.debut || 1;
    for (const ev of scenario.evenements) {
        const r = document.createElement('button');
        r.type = 'button';
        r.className = `repere ${ev.type}`;
        r.dataset.t = ev.debut;
        r.style.left = `${(100 * (ev.debut - scenario.debut) / duree).toFixed(2)}%`;
        if (ev.fin > ev.debut) r.style.width = `${(100 * (ev.fin - ev.debut) / duree).toFixed(2)}%`;
        r.title = `${texteHeure(ev.debut).slice(0, 5)} · ${ev.type}${ev.libelle ? ' : ' + ev.libelle : ''}`
            + (FABRIQUES[ev.type] || ev.type === 'jalon' ? '' : ' (pas encore dessiné)');
        r.addEventListener('click', () => allerA(ev.debut));
        reperes.appendChild(r);
    }
}

function verifier(s) {
    if (!s || s.format !== FORMAT) throw new Error('ce fichier n’est pas un scénario');
    if (s.version !== VERSION) throw new Error(`version ${s.version} du format, la page lit la ${VERSION}`);
    if (!(s.fin >= s.debut) || !Array.isArray(s.evenements)) throw new Error('scénario mal formé');
    return s;
}

function construire() {
    if (!scenario) return;
    for (const ev of scenario.evenements) {
        const fab = FABRIQUES[ev.type];
        if (!fab) continue;
        const e = fab(ev, scenario.vent || { de: 270, vitesse: 3 });
        e.placer();
        groupe.add(e.objet);
        effets.push(e);
    }
    allerA(temps);
}

async function charger() {
    etatCouche('etat-scenario', 'Scénario : chargement…', true);
    try {
        const r = await fetch(SOURCE, { cache: 'no-cache' });
        // Le site figé cherche toujours son scenario.json : absent, pas de calque.
        if (r.status === 404) { etatCouche('etat-scenario', ''); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        scenario = verifier(await r.json());
    } catch (e) {
        etatCouche('etat-scenario', `Scénario illisible (${SOURCE}) : ${e.message}`);
        return;
    }
    etatCouche('etat-scenario', '');
    document.getElementById('frise-titre').textContent = scenario.titre || 'Scénario';
    curseur.min = scenario.debut;
    curseur.max = scenario.fin;
    temps = scenario.debut;
    if (scenario.date) {
        curseurSaison.value = jourDeLAnnee(scenario.date);
        curseurSaison.dispatchEvent(new Event('input'));
    }
    poserReperes();
    bouton.hidden = false;
    bouton.classList.add('on');
    frise.hidden = false;
    // Le relief peut être déjà là : construire tout de suite, il replacera.
    construire();
}

poserSurLeRelief({
    // Arrivé avant le scénario, le relief le trouve vide ; après, il replace.
    construire: () => { for (const e of effets) e.placer(); },
    placer: () => { for (const e of effets) e.placer(); },
});

curseur.addEventListener('input', () => allerA(Number(curseur.value)));
lecture.addEventListener('click', () => {
    if (!enLecture && temps >= scenario.fin) allerA(scenario.debut);
    enLecture = !enLecture;
    lecture.textContent = enLecture ? '❚❚' : '▶';
    lecture.setAttribute('aria-label', enLecture ? 'Pause' : 'Lecture');
});
bouton.addEventListener('click', () => {
    const on = bouton.classList.toggle('on');
    frise.hidden = !on;
    groupe.visible = on;
    if (!on && enLecture) lecture.click();
    allerA(temps);
});

let precedent = performance.now();
function avancer(maintenant) {
    const dt = Math.min((maintenant - precedent) / 1000, 0.1);
    precedent = maintenant;
    if (enLecture && scenario) {
        allerA(temps + dt * Number(choixVitesse.value));
        if (temps >= scenario.fin) lecture.click();
    }
    requestAnimationFrame(avancer);
}
requestAnimationFrame(avancer);

if (SOURCE) charger();

/** Pour les essais : l'état de la frise. */
export const etatScenario = () => ({ scenario, temps, effets: effets.length });
