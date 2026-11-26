// Les couches publiques d'un camp (`&vaste=1`) : zones protégées, lignes
// électriques, ponts, gués et points d'eau, pistes et chemins classés. Rangées
// à côté de la page par horizon.yml (outils/couches_camp.py, gardées dans
// zones/<camp>-couches/) : couches.json les annonce, chacune a son bouton et
// n'est lue qu'au premier clic (les pistes font plusieurs Mo).
//
// Chaque objet porte sa `classe`, qui donne sa couleur et sa ligne de
// légende, et son `texte`, l'étiquette déjà rédigée par l'outil : la page n'a
// pas à connaître les attributs de la BD TOPO ou de l'INPN.
import * as THREE from 'three';
import { toLocal } from '../socle/projection.js';
import { scene, camera, renderer } from '../socle/rendu.js';
import { ySolPartout } from '../terrain/horizon.js';
import { citerSource, majCredits } from './credits.js';
import { VASTE } from './vaste.js';

// Couleur et libellé de chaque classe, couche par couche ; `ep` : la ligne est
// doublée (deux traits décalés de 1 m) pour se lire de loin.
export const STYLES = {
    protections: {
        titre: 'Zones protégées',
        aide: 'Natura 2000, ZNIEFF, parcs, réserves et arrêtés de biotope (INPN)',
        classes: {
            zps: { couleur: '#4cd964', libelle: 'Natura 2000, oiseaux (ZPS)' },
            zsc: { couleur: '#34c7a5', libelle: 'Natura 2000, habitats (ZSC, SIC)' },
            znieff1: { couleur: '#c7e36b', libelle: 'ZNIEFF de type 1' },
            znieff2: { couleur: '#9bb84a', libelle: 'ZNIEFF de type 2' },
            pn: { couleur: '#1fa34a', libelle: 'Parc national' },
            pnr: { couleur: '#7fbf3f', libelle: 'Parc naturel régional' },
            reserve: { couleur: '#ff9f0a', libelle: 'Réserve naturelle ou biologique' },
            apb: { couleur: '#ff6b81', libelle: 'Arrêté de protection (biotope, habitat)' },
            autre: { couleur: '#a3d9a5', libelle: 'Autre espace protégé' },
        },
    },
    electricite: {
        titre: 'Lignes électriques',
        aide: 'Lignes et postes électriques (BD TOPO), lignes de distribution d\'OpenStreetMap',
        classes: {
            ht: { couleur: '#ffcc00', libelle: 'Ligne haute tension' },
            distribution: { couleur: '#ff9500', libelle: 'Ligne de distribution (OSM)' },
            poste: { couleur: '#ffd60a', libelle: 'Poste ou transformateur' },
        },
    },
    eau: {
        titre: 'Ponts, gués, eau',
        aide: 'Ponts (et leur limite de tonnage), gués, points d\'eau, citernes DFCI et réservoirs (BD TOPO)',
        classes: {
            pont: { couleur: '#f2f2f7', libelle: 'Pont, passerelle' },
            gue: { couleur: '#ff9f0a', libelle: 'Gué ou radier' },
            citerne: { couleur: '#ff453a', libelle: 'Citerne (DFCI)' },
            point_eau: { couleur: '#5ac8fa', libelle: 'Point d\'eau, puits' },
            source: { couleur: '#64d2ff', libelle: 'Source, fontaine, lavoir' },
            reservoir: { couleur: '#0a84ff', libelle: 'Réservoir d\'eau' },
        },
    },
    pistes: {
        titre: 'Pistes et chemins',
        aide: 'Routes, routes empierrées, chemins et sentiers de la BD TOPO, pistes DFCI et points de rencontre des secours en forêt',
        classes: {
            route: { couleur: '#ffffff', libelle: 'Route revêtue' },
            dfci: { couleur: '#ff375f', libelle: 'Piste DFCI', ep: true },
            empierree: { couleur: '#ffb340', libelle: 'Route empierrée (piste)' },
            chemin: { couleur: '#c69c6d', libelle: 'Chemin' },
            sentier: { couleur: '#bf5af2', libelle: 'Sentier, escalier' },
            prsf: { couleur: '#ff3b30', libelle: 'Point de rencontre des secours (ONF)' },
        },
    },
};

const AU_DESSUS_M = 3;
// Les étiquettes d'une couche ne se montrent qu'en deçà de cette distance : 300
// points d'eau sur 35 km se recouvriraient vus de haut.
const PORTEE_M = { protections: 25000, electricite: 15000, eau: 6000, pistes: 4000 };
const pasDeRayon = () => {};

const $ = id => document.getElementById(id);
const couches = new Map();   // nom → { groupe, lignes, etiquettes, chargee, bouton }

function etiquette(texte, couleur) {
    const px = 12, echelle = 2;
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
    sprite.renderOrder = 11;
    sprite.raycast = pasDeRayon;
    return { sprite, ratio: l / h, hauteurPx: h / echelle };
}

/** Les segments d'une classe dans une seule géométrie : 18 000 tronçons de
 *  pistes en autant de THREE.Line feraient autant d'appels de dessin. */
function segments(couche, morceaux, couleur, double) {
    let n = 0;
    for (const m of morceaux) n += Math.max(0, m.length - 1) * 2;
    if (!n) return;
    const lonlat = new Float64Array(n * 2);
    let k = 0;
    for (const m of morceaux) {
        for (let i = 0; i + 1 < m.length; i++) {
            lonlat[k++] = m[i][0]; lonlat[k++] = m[i][1];
            lonlat[k++] = m[i + 1][0]; lonlat[k++] = m[i + 1][1];
        }
    }
    const decalages = double ? [0, 1] : [0];
    for (const d of decalages) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        const devant = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: couleur }));
        const derriere = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            color: couleur, transparent: true, opacity: 0.3, depthTest: false,
        }));
        devant.raycast = derriere.raycast = pasDeRayon;
        devant.frustumCulled = derriere.frustumCulled = false;
        couche.groupe.add(devant, derriere);
        couche.lignes.push({ geo, lonlat, dessus: AU_DESSUS_M + d * 1.5 });
    }
}

function morceauxDe(g) {
    switch (g.type) {
        case 'LineString': return [g.coordinates];
        case 'MultiLineString': return g.coordinates;
        case 'Polygon': return g.coordinates;
        case 'MultiPolygon': return g.coordinates.flat();
        default: return [];
    }
}

function poser(nom, fc) {
    const style = STYLES[nom], couche = couches.get(nom);
    const parClasse = new Map(), compte = new Map();
    for (const f of fc.features || []) {
        const p = f.properties || {}, g = f.geometry;
        if (!g) continue;
        const classe = style.classes[p.classe] ? p.classe : Object.keys(style.classes).at(-1);
        compte.set(classe, (compte.get(classe) || 0) + 1);
        const couleur = style.classes[classe].couleur;
        if (g.type === 'Point') {
            const [lon, lat] = g.coordinates;
            if (p.texte) {
                const e = etiquette(p.texte, couleur);
                couche.groupe.add(e.sprite);
                couche.etiquettes.push({ ...e, lon, lat, portee: PORTEE_M[nom] });
            }
            // Un repère vertical court : on voit où est le point sans son étiquette.
            const m = [[lon, lat], [lon, lat]];
            m.vertical = true;
            if (!parClasse.has(classe)) parClasse.set(classe, []);
            parClasse.get(classe).push(m);
            continue;
        }
        if (!parClasse.has(classe)) parClasse.set(classe, []);
        parClasse.get(classe).push(...morceauxDe(g));
        if (p.texte && p.etiquette) {
            const e = etiquette(p.texte, couleur);
            couche.groupe.add(e.sprite);
            couche.etiquettes.push({ ...e, lon: p.etiquette[0], lat: p.etiquette[1], portee: PORTEE_M[nom] });
        }
    }
    for (const [classe, morceaux] of parClasse) {
        const s = style.classes[classe];
        const lignes = morceaux.filter(m => !m.vertical), poteaux = morceaux.filter(m => m.vertical);
        segments(couche, lignes, s.couleur, s.ep);
        if (poteaux.length) poserPoteaux(couche, poteaux, s.couleur);
    }
    couche.compte = compte;
    couche.source = fc.source || '';
}

/** Les points : un trait vertical de 30 m, lisible de loin, sans texture. */
function poserPoteaux(couche, poteaux, couleur) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(poteaux.length * 6), 3));
    const trait = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: couleur, depthTest: false, transparent: true }));
    trait.raycast = pasDeRayon;
    trait.frustumCulled = false;
    trait.renderOrder = 10;
    couche.groupe.add(trait);
    couche.poteaux = couche.poteaux || [];
    couche.poteaux.push({ geo, points: poteaux.map(m => m[0]) });
}

/** L'altitude relue : l'horizon se précise tuile après tuile. */
function reposer(couche) {
    for (const { geo, lonlat, dessus } of couche.lignes) {
        const pos = geo.attributes.position.array;
        for (let i = 0, j = 0; i < lonlat.length; i += 2, j += 3) {
            const [x, y] = toLocal(lonlat[i], lonlat[i + 1]);
            pos[j] = x; pos[j + 1] = (ySolPartout(lonlat[i], lonlat[i + 1]) ?? 0) + dessus; pos[j + 2] = -y;
        }
        geo.attributes.position.needsUpdate = true;
        geo.computeBoundingSphere();
    }
    for (const { geo, points } of couche.poteaux || []) {
        const pos = geo.attributes.position.array;
        points.forEach(([lon, lat], i) => {
            const [x, y] = toLocal(lon, lat), z = ySolPartout(lon, lat) ?? 0;
            pos.set([x, z, -y, x, z + 30, -y], i * 6);
        });
        geo.attributes.position.needsUpdate = true;
        geo.computeBoundingSphere();
    }
    for (const e of couche.etiquettes) {
        const [x, y] = toLocal(e.lon, e.lat);
        e.sprite.position.set(x, (ySolPartout(e.lon, e.lat) ?? 0) + 32, -y);
    }
}

function majEtiquettes() {
    const h = renderer.domElement.clientHeight || 1;
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / h;
    for (const c of couches.values()) {
        if (!c.groupe.visible) continue;
        for (const e of c.etiquettes) {
            e.sprite.visible = camera.position.distanceTo(e.sprite.position) < e.portee;
            e.sprite.scale.set(e.hauteurPx * e.ratio * k, e.hauteurPx * k, 1);
        }
    }
}

function majLegende() {
    const div = $('camp-legende');
    div.textContent = '';
    for (const [nom, c] of couches) {
        if (!c.groupe.visible || !c.compte) continue;
        for (const [classe, s] of Object.entries(STYLES[nom].classes)) {
            const n = c.compte.get(classe);
            if (!n) continue;
            const ligne = document.createElement('div');
            const pastille = document.createElement('i');
            pastille.style.background = s.couleur;
            ligne.append(pastille, `${s.libelle} `);
            const b = document.createElement('b');
            b.textContent = n.toLocaleString('fr-FR');
            ligne.append(b);
            div.append(ligne);
        }
    }
    div.hidden = !div.childElementCount;
}

async function basculer(nom) {
    const c = couches.get(nom);
    if (!c.chargee) {
        c.bouton.disabled = true;
        c.bouton.textContent = `${STYLES[nom].titre}…`;
        try {
            const r = await fetch(`couches/${nom}.geojson`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            poser(nom, await r.json());
            c.chargee = true;
        } catch (e) {
            $('camp-note').textContent = `${STYLES[nom].titre} : fichier illisible (${e.message}).`;
            return;
        } finally {
            c.bouton.disabled = false;
            c.bouton.textContent = STYLES[nom].titre;
        }
    }
    c.groupe.visible = c.bouton.classList.toggle('on');
    if (c.groupe.visible) reposer(c);
    majLegende();
    majEtiquettes();
    majCredits();
}

// Sans await au niveau du module : les modules suivants attendraient le fichier.
if (VASTE) demarrer();

async function demarrer() {
    const index = await fetch('couches/couches.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!index || !index.couches) return;      // un camp publié avant ces couches
    const boutons = $('camp-couches');
    for (const nom of Object.keys(STYLES)) {
        const info = index.couches[nom];
        if (!info || !info.objets) continue;
        const groupe = new THREE.Group();
        groupe.name = `camp-${nom}`;
        groupe.visible = false;
        scene.add(groupe);
        const bouton = document.createElement('button');
        bouton.className = 'toggle';
        bouton.id = `t-camp-${nom}`;
        bouton.textContent = STYLES[nom].titre;
        bouton.title = `${STYLES[nom].aide} : ${info.objets.toLocaleString('fr-FR')} objets`;
        bouton.addEventListener('click', () => basculer(nom));
        boutons.append(bouton);
        couches.set(nom, { groupe, lignes: [], etiquettes: [], chargee: false, bouton, source: info.source || '' });
    }
    if (!couches.size) return;
    $('sec-camp').hidden = false;
    if (index.date) $('camp-note').textContent = `Données lues le ${new Date(index.date).toLocaleDateString('fr-FR')}, à vérifier sur le terrain.`;
    citerSource('couches-camp', () => [...couches.entries()]
        .filter(([, c]) => c.groupe.visible).map(([nom, c]) => ({ nom: STYLES[nom].titre, source: c.source })));
    setInterval(() => { for (const c of couches.values()) if (c.groupe.visible) reposer(c); }, 3000);
    setInterval(majEtiquettes, 250);
}
