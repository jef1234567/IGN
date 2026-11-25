// Calque scénario : un scenario.json (outils/scenario.py, depuis le tableur)
// rejoué sur une frise. Le temps de la frise règle le soleil et les effets ;
// elle dessine les fumigènes et les unités (symbole APP-6 qui suit son
// itinéraire) ; les autres types du format (explosion, incendie, nuit) sont
// déjà placés sur la frise. Le format : js/commun/scenario.js.
//
//   ?…&scenario=scenario.json      chemin relatif à la page
//   ?…&scenario=brouillon          le brouillon de l'éditeur (editeur.html),
//                                  gardé par ce navigateur
//
// Chaque effet est une fonction du temps de la frise, sans état : reculer,
// sauter à un événement ou accélérer rend la même image qu'en lecture.

import * as THREE from 'three';
import { scene, soleil, camera, renderer } from '../socle/rendu.js';
import { toLocal, toLonLat as toLonLatLocal } from '../socle/projection.js';
import { BORNES } from '../terrain/etat.js';
import { ySolPartout } from '../terrain/horizon.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { etatCouche } from '../interface/etat-couche.js';
import {
    COULEURS_FUMEE as COULEURS, COULEURS_CAMP, positionUnite, sidc, texteRelatif, phaseEnCours, texteHeure, verifierScenario as verifier, CLE_BROUILLON,
} from '../../commun/scenario.js';

const SOURCE = new URLSearchParams(location.search).get('scenario');

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
        // Hors de la scène, le sol est celui de l'horizon, plus fin à mesure
        // que ses tuiles arrivent : `aReplacer` le fait relire (replacerHorsScene).
        placer() {
            const y = ySolPartout(ev.lon, ev.lat);
            points.position.y = y ?? 0;
            this.aReplacer = !dansLaScene(ev.lon, ev.lat);
        },
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

// --- Unité ----------------------------------------------------------------------
// Son symbole APP-6 (milsymbol, chargé par la page) en panneau toujours face à
// la caméra, UNITE_HAUTEUR_M au-dessus du sol, à la position du moment sur
// son itinéraire. Taille fixe à l'écran : lisible de près comme de loin.
const UNITE_HAUTEUR_M = 12;
const UNITE_ECRAN = 0.06;     // fraction de la hauteur de la vue

function creerUnite(ev) {
    const p = ev.params || {};
    const toile = window.ms ? new window.ms.Symbol(p.sidc || sidc(p), { size: 60 }).asCanvas() : null;
    if (!toile) return null;
    const texture = new THREE.CanvasTexture(toile);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false, sizeAttenuation: false }));
    sprite.renderOrder = 10;
    sprite.scale.set(UNITE_ECRAN * toile.width / toile.height, UNITE_ECRAN, 1);
    sprite.userData.infobulle = ev.libelle || p.sidc;
    let posee = null;
    return {
        ev, objet: sprite, aReplacer: true,     // arrêtée hors scène, l'horizon s'affine sous elle
        placer() { if (posee) sprite.position.y = (ySolPartout(posee.lon, posee.lat) ?? 0) + UNITE_HAUTEUR_M; },
        maj(t) {
            const pos = Number.isFinite(t) ? positionUnite(ev, t) : null;
            sprite.visible = !!pos;
            if (!pos) return;
            posee = pos;
            const [x, y] = toLocal(pos.lon, pos.lat);
            sprite.position.set(x, (ySolPartout(pos.lon, pos.lat) ?? 0) + UNITE_HAUTEUR_M, -y);
            // Pas encore entrée : en attente, pâle, à son premier point.
            sprite.material.opacity = pos.avant ? 0.35 : 1;
        },
    };
}

// --- Tracé de manœuvre ---------------------------------------------------------
// Un ruban posé sur le relief, redécoupé tous les PAS_RUBAN_M pour en suivre
// les creux (un segment de 300 m tendu entre deux points passerait sous une
// butte) ; la flèche finit en pointe, la zone se referme. Son nom, en
// étiquette au-dessus du milieu.
const PAS_RUBAN_M = 10;
const LARGEUR_M = { fleche: 5, ligne: 2, zone: 2 };

function etiquetteSprite(texte, couleur) {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    g.font = '600 28px system-ui';
    c.width = Math.ceil(g.measureText(texte).width) + 16;
    c.height = 40;
    g.font = '600 28px system-ui';
    g.lineWidth = 6; g.strokeStyle = '#000'; g.fillStyle = couleur;
    g.strokeText(texte, 8, 29); g.fillText(texte, 8, 29);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, sizeAttenuation: false }));
    sp.renderOrder = 11;
    sp.scale.set(0.03 * c.width / c.height, 0.03, 1);
    return sp;
}

function creerTrace(ev) {
    const p = ev.params || {}, pts = (p.points || []).map(q => toLocal(q.lon, q.lat));
    if (pts.length < 2) return null;
    if (p.forme === 'zone') pts.push(pts[0]);
    // Axe redécoupé, en mètres locaux [x, nord].
    const axe = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / PAS_RUBAN_M));
        for (let k = 1; k <= n; k++) axe.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
    }
    const demi = (LARGEUR_M[p.forme] || 2) / 2, fleche = p.forme === 'fleche';
    const tete = fleche ? 4 : 0;                // dernier tronçon remplacé par la pointe
    const sommets = [], cotes = [];
    const corps = fleche ? axe.length - tete : axe.length;
    for (let i = 0; i < corps; i++) {
        const [xa, ya] = axe[Math.max(i - 1, 0)], [xb, yb] = axe[Math.min(i + 1, axe.length - 1)];
        const l = Math.hypot(xb - xa, yb - ya) || 1, nx = -(yb - ya) / l, ny = (xb - xa) / l;
        cotes.push([axe[i][0] + nx * demi, axe[i][1] + ny * demi], [axe[i][0] - nx * demi, axe[i][1] - ny * demi]);
    }
    const index = [];
    for (let i = 0; i < corps - 1; i++) index.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
    if (fleche) {
        // Pointe : trois fois la largeur du trait, du dernier point du corps au bout.
        const [xa, ya] = axe[corps - 1], [xb, yb] = axe[axe.length - 1];
        const l = Math.hypot(xb - xa, yb - ya) || 1, nx = -(yb - ya) / l, ny = (xb - xa) / l, k = cotes.length;
        cotes.push([xa + nx * demi * 4, ya + ny * demi * 4], [xa - nx * demi * 4, ya - ny * demi * 4], [xb, yb]);
        index.push(k, k + 2, k + 1);
    }
    for (const c of cotes) sommets.push(c[0], 0, -c[1]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(sommets, 3));
    geo.setIndex(index);
    const couleur = COULEURS_CAMP[p.camp] || COULEURS_CAMP.neutre;
    const ruban = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: couleur, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4 }));
    ruban.renderOrder = 5;
    const objet = new THREE.Group();
    objet.add(ruban);
    let etiquette = null;
    if (ev.libelle) {
        etiquette = etiquetteSprite(ev.libelle, p.camp === 'neutre' || !p.camp ? '#ffffff' : couleur);
        objet.add(etiquette);
    }
    const milieu = p.forme === 'zone'
        ? pts.slice(0, -1).reduce(([a, b], [c, d]) => [a + c / (pts.length - 1), b + d / (pts.length - 1)], [0, 0])
        : axe[Math.floor(axe.length / 2)];
    return {
        ev, objet,
        placer() {
            const pos = geo.attributes.position;
            let dehors = false;
            for (let i = 0; i < pos.count; i++) {
                const [lon, lat] = toLonLatLocal(pos.getX(i), -pos.getZ(i));
                pos.setY(i, (ySolPartout(lon, lat) ?? 0) + 0.6);
                dehors ||= !dansLaScene(lon, lat);
            }
            // Un tracé qui sort de la scène suit l'horizon à mesure qu'il s'affine.
            this.aReplacer = dehors;
            pos.needsUpdate = true;
            if (etiquette) {
                const [lon, lat] = toLonLatLocal(milieu[0], milieu[1]);
                etiquette.position.set(milieu[0], (ySolPartout(lon, lat) ?? 0) + 8, -milieu[1]);
            }
        },
        maj(t) { objet.visible = Number.isFinite(t) && t >= ev.debut && (ev.fin == null || t <= ev.fin); },
    };
}

const FABRIQUES = { fumigene: creerFumigene, unite: creerUnite, trace: creerTrace };

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
    const phase = phaseEnCours(scenario, temps);
    affHeure.textContent = texteHeure(temps) + (scenario.heure_h != null ? ` · ${texteRelatif(temps, scenario.heure_h)}` : '');
    document.getElementById('frise-titre').textContent = phase ? phase.libelle : (scenario.titre || 'Scénario');
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
            + (FABRIQUES[ev.type] || ev.type === 'jalon' || ev.type === 'phase' ? '' : ' (pas encore dessiné)');
        if (ev.type === 'unite' && ev.fin > ev.debut) r.title += ` → ${texteHeure(ev.fin).slice(0, 5)}`;
        r.addEventListener('click', () => allerA(ev.debut));
        reperes.appendChild(r);
    }
}

function construire() {
    if (!scenario) return;
    for (const ev of scenario.evenements) {
        const fab = FABRIQUES[ev.type];
        if (!fab) continue;
        const e = fab(ev, scenario.vent || { de: 270, vitesse: 3 });
        if (!e) continue;
        e.placer();
        groupe.add(e.objet);
        effets.push(e);
    }
    allerA(temps);
}

async function charger() {
    etatCouche('etat-scenario', 'Scénario : chargement…', true);
    try {
        if (SOURCE === 'brouillon') {
            let brouillon = null;
            try { brouillon = localStorage.getItem(CLE_BROUILLON); } catch (e) { /* stockage refusé */ }
            if (!brouillon) throw new Error('aucun brouillon dans ce navigateur');
            scenario = verifier(JSON.parse(brouillon));
        } else {
        const r = await fetch(SOURCE, { cache: 'no-cache' });
        // Le site figé cherche toujours son scenario.json : absent, pas de calque.
        if (r.status === 404) { etatCouche('etat-scenario', ''); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        scenario = verifier(await r.json());
        }
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

function dansLaScene(lon, lat) {
    return lon >= BORNES.o && lon <= BORNES.e && lat >= BORNES.s && lat <= BORNES.n;
}

// Toutes les REPLACER_MS, les effets hors de la scène relisent leur sol :
// l'horizon s'affine au fil du vol, et ses tuiles fines ne sont chargées que
// près de la caméra. Quelques effets, quelques lectures de tuile : rien à
// mesurer face au rendu.
const REPLACER_MS = 2000;
setInterval(() => { for (const e of effets) if (e.aReplacer) e.placer(); }, REPLACER_MS);

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

// L'éditeur de scénario, sur le même point (et le même site).
{
    const p = new URLSearchParams(location.search);
    p.delete('scenario');
    document.getElementById('lien-editeur').href = `editeur.html?${p}`;
}

/** Pour les essais : l'état de la frise. */
export const etatScenario = () => ({ scenario, temps, effets: effets.length });
