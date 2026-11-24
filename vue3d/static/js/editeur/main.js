// Éditeur de scénario : la carte 2D de la scène (son orthophoto), où l'on pose
// fumigènes, jalons et unités APP-6 à l'heure de la frise. Le travail est
// gardé dans le navigateur (brouillon), exporté en scenario.json, le format
// que lit la vue 3D (js/commun/scenario.js).
//
//   editeur.html?lat=49.5454&lon=3.9665&zone=1700
//
// Une seule personne, un seul poste : pas de serveur, rien n'est envoyé.

import {
    FORMAT, VERSION, COULEURS_FUMEE, DUREE_FUMIGENE_S, TAILLE_FUMIGENE_M, CAMPS, ARMES, ECHELONS,
    sidc, positionUnite, texteHeure, lireHeure, verifierScenario, CLE_BROUILLON,
} from '../commun/scenario.js';

// --- Le point et son emprise : la règle du serveur (vue3d/scene.py) -----------
// Point arrondi à 4 décimales (SCENE_ARRONDI), zone arrondie à 50 m et bornée
// à 150–2 000 m, même écart en degrés dans les deux sens (emprise()). Sans
// point dans l'URL, la scène CENZUB que le site fige.
const PARAMS = new URLSearchParams(location.search);
const nombre = n => { const v = Number(String(PARAMS.get(n) ?? '').replace(',', '.')); return PARAMS.get(n) !== null && Number.isFinite(v) ? v : null; };
const LAT = nombre('lat') ?? 49.5454;
const LON = nombre('lon') ?? 3.9665;
const ZONE = Math.min(Math.max(Math.round((nombre('zone') ?? 1700) / 50) * 50, 150), 2000);
const REQUETE = `lat=${LAT}&lon=${LON}&zone=${ZONE}`;
const DEMI = ZONE / 2 / 111320;
const [LATR, LONR] = [Math.round(LAT * 1e4) / 1e4, Math.round(LON * 1e4) / 1e4];
const BBOX = [LONR - DEMI, LATR - DEMI, LONR + DEMI, LATR + DEMI];   // ouest, sud, est, nord
const M_LAT = 111320, M_LON = 111320 * Math.cos(LAT * Math.PI / 180);
const versLocal = (lon, lat) => [(lon - LON) * M_LON, (lat - LAT) * M_LAT];
const versLonLat = (x, y) => [LON + x / M_LON, LAT + y / M_LAT];

// --- État -------------------------------------------------------------------------
let S = null;               // le scénario
let choix = null;           // id de l'événement choisi
let outil = 'selection';
let temps = 0;
let enLecture = false;
const vue = { x: 0, y: 0, e: 1 };   // centre de la vue (m) et échelle (px/m)

const $ = id => document.getElementById(id);
const toile = $('toile'), ctx = toile.getContext('2d');
const ortho = new Image();
let orthoPrete = false;

function nouveauScenario() {
    const d = new Date();
    return {
        format: FORMAT, version: VERSION, titre: 'Nouveau scénario',
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        debut: 6 * 3600, fin: 7 * 3600, vent: { de: 270, vitesse: 3 }, points: {}, evenements: [],
    };
}

const nouvelId = () => 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
const evenement = id => S.evenements.find(e => e.id === id);

function etat(texte) {
    $('etat').hidden = !texte;
    $('etat').textContent = texte || '';
}

/** Après toute modification : tri, bornes de la frise, brouillon, affichage. */
function modifie() {
    for (const ev of S.evenements) if (ev.type === 'unite') bornerUnite(ev);
    S.evenements.sort((a, b) => a.debut - b.debut || a.id.localeCompare(b.id));
    const dernier = Math.max(S.debut, ...S.evenements.map(e => e.fin ?? e.debut));
    if (dernier > S.fin) S.fin = Math.ceil(dernier / 300) * 300;
    try { localStorage.setItem(CLE_BROUILLON, JSON.stringify(S)); }
    catch (e) { etat('Brouillon non gardé par le navigateur : pensez à exporter.'); }
    majEntete();
    majFrise();
    majListe();
    majProprietes();
    dessiner();
}

function bornerUnite(ev) {
    const tr = ev.params.trajet;
    tr.sort((a, b) => a.t - b.t);
    ev.debut = tr[0].t;
    ev.fin = tr[tr.length - 1].t;
    ev.lat = tr[0].lat;
    ev.lon = tr[0].lon;
    // Un SIDC venu d'ailleurs (un OPO traduit) est gardé tel quel.
    ev.params.sidc ??= sidc(ev.params);
}

// --- Carte ------------------------------------------------------------------------
function dimensionner() {
    const r = toile.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    toile.width = Math.round(r.width * d);
    toile.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    dessiner();
}
const largeur = () => toile.width / (window.devicePixelRatio || 1);
const hauteur = () => toile.height / (window.devicePixelRatio || 1);
const versEcran = (x, y) => [largeur() / 2 + (x - vue.x) * vue.e, hauteur() / 2 - (y - vue.y) * vue.e];
const depuisEcran = (px, py) => [vue.x + (px - largeur() / 2) / vue.e, vue.y - (py - hauteur() / 2) / vue.e];
const ecranDe = (lon, lat) => versEcran(...versLocal(lon, lat));

function cadrer() {
    const [x0, y0] = versLocal(BBOX[0], BBOX[1]), [x1, y1] = versLocal(BBOX[2], BBOX[3]);
    vue.x = (x0 + x1) / 2;
    vue.y = (y0 + y1) / 2;
    vue.e = Math.min(largeur() / (x1 - x0), hauteur() / (y1 - y0)) * 0.95;
}

const symboles = new Map();
function symbole(code, taille = 26) {
    const cle = code + taille;
    if (!symboles.has(cle)) {
        symboles.set(cle, window.ms ? new window.ms.Symbol(code, { size: taille }).asCanvas() : null);
    }
    return symboles.get(cle);
}

const COULEUR_CAMP = { ami: '#4f9cf0', ennemi: '#e0533f' };

function dessiner() {
    if (!S) return;
    const W = largeur(), H = hauteur();
    ctx.clearRect(0, 0, W, H);
    const [ax, ay] = ecranDe(BBOX[0], BBOX[3]), [bx, by] = ecranDe(BBOX[2], BBOX[1]);
    if (orthoPrete) ctx.drawImage(ortho, ax, ay, bx - ax, by - ay);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.strokeRect(ax, ay, bx - ax, by - ay);

    for (const ev of S.evenements) if (ev.type === 'fumigene') dessinerFumigene(ev);
    for (const ev of S.evenements) if (ev.type === 'unite') dessinerUnite(ev);
    // Échelle graphique : 100 m.
    const l = 100 * vue.e;
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W - 20 - l, H - 18); ctx.lineTo(W - 20, H - 18); ctx.stroke();
    ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('100 m', W - 20 - l / 2, H - 24);
}

function dessinerFumigene(ev) {
    const p = ev.params || {};
    const [x, y] = ecranDe(ev.lon, ev.lat);
    const actif = temps >= ev.debut && temps <= ev.fin;
    const r = Math.max(5, (p.taille_m || TAILLE_FUMIGENE_M) / 2 * vue.e);
    const couleur = COULEURS_FUMEE[p.couleur] || COULEURS_FUMEE.blanc;
    ctx.save();
    if (actif) {
        // Le panache sous le vent : 45 s de vent, comme dans la vue 3D.
        const de = p.vent_d_ou ?? S.vent.de, v = p.vent_m_s ?? S.vent.vitesse;
        const vers = (de + 180) * Math.PI / 180, long = v * 45 * vue.e;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = couleur;
        ctx.beginPath();
        ctx.ellipse(x + Math.sin(vers) * long / 2, y - Math.cos(vers) * long / 2,
                    Math.max(r * 1.4, 4), Math.max(long / 2, r), vers, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 0.9;
    } else {
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([3, 3]);
    }
    ctx.fillStyle = couleur;
    ctx.strokeStyle = ev.id === choix ? '#fff' : '#000';
    ctx.lineWidth = ev.id === choix ? 2.5 : 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (actif) ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function dessinerUnite(ev) {
    const p = ev.params, tr = p.trajet, choisie = ev.id === choix;
    const couleur = COULEUR_CAMP[p.camp] || COULEUR_CAMP.ami;
    ctx.save();
    ctx.strokeStyle = couleur;
    ctx.lineWidth = choisie ? 2.5 : 1.5;
    ctx.globalAlpha = choisie ? 1 : 0.7;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    tr.forEach((pt, i) => { const [x, y] = ecranDe(pt.lon, pt.lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    for (const pt of tr) {
        const [x, y] = ecranDe(pt.lon, pt.lat);
        ctx.fillStyle = couleur;
        ctx.beginPath(); ctx.arc(x, y, choisie ? 5 : 3, 0, 2 * Math.PI); ctx.fill();
        if (choisie) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
            ctx.strokeText(texteHeure(pt.t, false), x + 7, y - 6);
            ctx.fillText(texteHeure(pt.t, false), x + 7, y - 6);
        }
    }
    const pos = positionUnite(ev, temps);
    const img = symbole(p.sidc);
    if (pos && img) {
        const [x, y] = ecranDe(pos.lon, pos.lat);
        ctx.globalAlpha = pos.avant ? 0.4 : 1;
        ctx.drawImage(img, x - img.width / 2, y - img.height / 2);
        if (ev.libelle) {
            ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
            ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.fillStyle = '#fff';
            ctx.strokeText(ev.libelle, x, y + img.height / 2 + 11);
            ctx.fillText(ev.libelle, x, y + img.height / 2 + 11);
        }
        if (choisie) {
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]);
            ctx.strokeRect(x - img.width / 2 - 3, y - img.height / 2 - 3, img.width + 6, img.height + 6);
        }
    }
    ctx.restore();
}

// --- Souris -----------------------------------------------------------------------
/** Ce qui est sous le pointeur : un point d'itinéraire de l'unité choisie, une unité, un fumigène. */
function cible(px, py) {
    const ch = choix && evenement(choix);
    if (ch && ch.type === 'unite') {
        for (const pt of ch.params.trajet) {
            const [x, y] = ecranDe(pt.lon, pt.lat);
            if (Math.hypot(px - x, py - y) < 8) return { ev: ch, point: pt };
        }
    }
    for (const ev of [...S.evenements].reverse()) {
        if (ev.type === 'unite') {
            const pos = positionUnite(ev, temps);
            if (!pos) continue;
            const [x, y] = ecranDe(pos.lon, pos.lat);
            if (Math.abs(px - x) < 18 && Math.abs(py - y) < 16) return { ev };
        } else if (ev.type === 'fumigene') {
            const [x, y] = ecranDe(ev.lon, ev.lat);
            const r = Math.max(8, (ev.params?.taille_m || TAILLE_FUMIGENE_M) / 2 * vue.e);
            if (Math.hypot(px - x, py - y) < r) return { ev };
        }
    }
    return null;
}

let glisse = null;
toile.addEventListener('pointerdown', e => {
    const px = e.offsetX, py = e.offsetY;
    const [lon, lat] = versLonLat(...depuisEcran(px, py));
    toile.setPointerCapture(e.pointerId);
    if (outil === 'fumigene') {
        const ev = { id: nouvelId(), type: 'fumigene', debut: Math.round(temps), fin: Math.round(temps) + DUREE_FUMIGENE_S,
                     libelle: 'Fumigène', lat, lon, params: { couleur: 'blanc', taille_m: TAILLE_FUMIGENE_M } };
        S.evenements.push(ev);
        choisir(ev.id);
        return modifie();
    }
    if (outil === 'unite') {
        const params = { camp: 'ami', arme: 'infanterie', echelon: 'section', pc: false,
                         trajet: [{ t: Math.round(temps), lat, lon }] };
        const ev = { id: nouvelId(), type: 'unite', debut: Math.round(temps), libelle: 'Unité', lat, lon, params };
        S.evenements.push(ev);
        choisir(ev.id);
        choisirOutil('itineraire');
        return modifie();
    }
    if (outil === 'itineraire') {
        const ev = evenement(choix);
        if (!ev || ev.type !== 'unite') return choisirOutil('selection');
        const t = Math.round(temps), tr = ev.params.trajet;
        const meme = tr.find(pt => pt.t === t);
        if (meme) Object.assign(meme, { lat, lon });
        else tr.push({ t, lat, lon });
        return modifie();
    }
    const c = cible(px, py);
    if (c) {
        choisir(c.ev.id);
        glisse = { c, px, py, lon, lat, avant: JSON.stringify(c.ev) };
    } else {
        glisse = { pan: true, px, py, x: vue.x, y: vue.y };
        if (choix) choisir(null);
    }
});
toile.addEventListener('pointermove', e => {
    if (!glisse) return;
    const px = e.offsetX, py = e.offsetY;
    if (glisse.pan) {
        vue.x = glisse.x - (px - glisse.px) / vue.e;
        vue.y = glisse.y + (py - glisse.py) / vue.e;
        return dessiner();
    }
    const [lon, lat] = versLonLat(...depuisEcran(px, py));
    const dlon = lon - glisse.lon, dlat = lat - glisse.lat;
    glisse.lon = lon; glisse.lat = lat;
    const { ev, point } = glisse.c;
    if (point) { point.lon += dlon; point.lat += dlat; }
    else if (ev.type === 'unite') for (const pt of ev.params.trajet) { pt.lon += dlon; pt.lat += dlat; }
    else { ev.lon += dlon; ev.lat += dlat; }
    glisse.bouge = true;
    dessiner();
});
toile.addEventListener('pointerup', () => {
    if (glisse && glisse.bouge) modifie();
    glisse = null;
});
toile.addEventListener('wheel', e => {
    e.preventDefault();
    const [x, y] = depuisEcran(e.offsetX, e.offsetY);
    vue.e = Math.min(Math.max(vue.e * Math.exp(-e.deltaY * 0.0015), 0.05), 20);
    const [x2, y2] = depuisEcran(e.offsetX, e.offsetY);
    vue.x += x - x2; vue.y += y - y2;
    dessiner();
}, { passive: false });
toile.addEventListener('dblclick', () => { cadrer(); dessiner(); });
window.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && choix) { supprimer(choix); e.preventDefault(); }
    if (e.key === 'Escape') { choisirOutil('selection'); choisir(null); }
    if (e.key === ' ') { $('frise-lecture').click(); e.preventDefault(); }
});

const AIDES = {
    selection: 'Clic : choisir · glisser : déplacer (une unité entière, ou un point de son itinéraire) · glisser le fond : se déplacer · molette : zoom · double-clic : recadrer · Suppr : supprimer',
    fumigene: 'Clic sur la carte : un fumigène qui part à l’heure de la frise (2 min, à régler dans le panneau).',
    unite: 'Clic sur la carte : l’unité, entrée à l’heure de la frise. Ensuite, avancez la frise et cliquez pour chaque point de son itinéraire.',
    itineraire: 'Avancez la frise (curseur, −1/+1 min), puis cliquez : un point de l’itinéraire à cette heure. Même heure : le point est déplacé. Échap pour finir.',
};
function choisirOutil(o) {
    outil = o;
    for (const b of document.querySelectorAll('#outils [data-outil]')) b.classList.toggle('on', b.dataset.outil === o);
    $('aide').textContent = AIDES[o];
    toile.style.cursor = o === 'selection' ? 'default' : 'crosshair';
}
for (const b of document.querySelectorAll('#outils [data-outil]')) {
    b.addEventListener('click', () => choisirOutil(b.dataset.outil));
}
$('b-jalon').addEventListener('click', () => {
    const ev = { id: nouvelId(), type: 'jalon', debut: Math.round(temps), libelle: 'Jalon' };
    S.evenements.push(ev);
    choisir(ev.id);
    modifie();
});

function choisir(id) {
    choix = id;
    const ev = id && evenement(id);
    $('outils').querySelector('[data-outil="itineraire"]').disabled = !(ev && ev.type === 'unite');
    if (outil === 'itineraire' && !(ev && ev.type === 'unite')) choisirOutil('selection');
    majListe();
    majProprietes();
    dessiner();
}

function supprimer(id) {
    S.evenements = S.evenements.filter(e => e.id !== id);
    choisir(null);
    modifie();
}

// --- Panneau ----------------------------------------------------------------------
const echapper = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const options = (table, valeur) => Object.entries(table)
    .map(([k, v]) => `<option value="${k}"${k === valeur ? ' selected' : ''}>${echapper(Array.isArray(v) ? v[0] : k)}</option>`).join('');

function champHeure(nom, s) {
    return `<input data-heure="${nom}" value="${s == null ? '' : texteHeure(s).replace(' (J+1)', '')}" size="8">`;
}

function majProprietes() {
    const ev = choix && evenement(choix), boite = $('proprietes');
    boite.hidden = !ev;
    if (!ev) return;
    const p = ev.params || {};
    let html = `<h2>${{ fumigene: 'Fumigène', jalon: 'Jalon', unite: 'Unité' }[ev.type] || ev.type}</h2>`;
    html += `<label>${ev.type === 'unite' ? 'Nom' : 'Libellé'} <input data-champ="libelle" value="${echapper(ev.libelle)}"></label>`;
    if (ev.type === 'fumigene') {
        html += `<label>Début ${champHeure('debut', ev.debut)}</label><label>Fin ${champHeure('fin', ev.fin)}</label>`
            + `<label>Couleur <select data-param="couleur">${options(COULEURS_FUMEE, p.couleur || 'blanc')}</select></label>`
            + `<label>Taille (m) <input type="number" min="2" max="100" data-param="taille_m" value="${p.taille_m ?? TAILLE_FUMIGENE_M}"></label>`
            + `<label title="Vide : le vent du scénario">Vent de (°) <input type="number" min="0" max="359" data-param="vent_d_ou" value="${p.vent_d_ou ?? ''}" placeholder="${S.vent.de}"></label>`
            + `<label title="Vide : le vent du scénario">Vent (m/s) <input type="number" min="0" max="30" step="0.5" data-param="vent_m_s" value="${p.vent_m_s ?? ''}" placeholder="${S.vent.vitesse}"></label>`;
    } else if (ev.type === 'jalon') {
        html += `<label>Heure ${champHeure('debut', ev.debut)}</label>`;
    } else if (ev.type === 'unite') {
        const img = symbole(p.sidc, 34);
        html += `<div class="symbole">${img ? `<img src="${img.toDataURL()}" alt="${echapper(p.sidc)}">` : ''}</div>`
            + `<label>Camp <select data-param="camp">${options({ ami: ['Ami'], ennemi: ['Ennemi'] }, p.camp)}</select></label>`
            + `<label>Arme <select data-param="arme">${options(ARMES, p.arme)}</select></label>`
            + `<label>Échelon <select data-param="echelon">${options(ECHELONS, p.echelon)}</select></label>`
            + `<label>Poste de commandement <input type="checkbox" data-param="pc"${p.pc ? ' checked' : ''}></label>`
            + `<label>SIDC <input value="${echapper(p.sidc)}" readonly></label>`
            + '<table><tr><td colspan="3"><b>Itinéraire</b> (outil Itinéraire pour ajouter)</td></tr>'
            + p.trajet.map((pt, i) => `<tr><td>${i + 1}</td><td><input data-point="${i}" value="${texteHeure(pt.t).replace(' (J+1)', '')}" size="8"></td>`
                + `<td><button type="button" data-aller="${pt.t}" title="Frise à cette heure">→</button>`
                + `${p.trajet.length > 1 ? ` <button type="button" data-oter="${i}" title="Retirer ce point">×</button>` : ''}</td></tr>`).join('')
            + '</table>';
    }
    html += `<div class="ligne"><button type="button" data-aller="${ev.debut}">Aller au début</button>`
        + '<button type="button" data-supprimer>Supprimer</button></div>';
    boite.innerHTML = html;
}

$('proprietes').addEventListener('change', e => {
    const ev = evenement(choix), c = e.target;
    if (!ev) return;
    ev.params ??= {};
    if (c.dataset.champ) ev[c.dataset.champ] = c.value.trim();
    if (c.dataset.param) {
        const k = c.dataset.param;
        if (c.type === 'checkbox') ev.params[k] = c.checked;
        else if (c.type === 'number') { if (c.value === '') delete ev.params[k]; else ev.params[k] = Number(c.value); }
        else ev.params[k] = c.value;
        if (['camp', 'arme', 'echelon', 'pc'].includes(k)) ev.params.sidc = sidc(ev.params);
    }
    if (c.dataset.heure || c.dataset.point) {
        const s = lireHeure(c.value, S.debut);
        if (s === null) { etat(`Heure illisible : ${c.value} (HH:MM ou HH:MM:SS)`); return majProprietes(); }
        etat('');
        if (c.dataset.point) ev.params.trajet[+c.dataset.point].t = s;
        else ev[c.dataset.heure] = s;
        if (ev.type === 'fumigene' && ev.fin < ev.debut) ev.fin = ev.debut + DUREE_FUMIGENE_S;
    }
    modifie();
});
$('proprietes').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.aller) allerA(+b.dataset.aller);
    if (b.dataset.oter) { evenement(choix).params.trajet.splice(+b.dataset.oter, 1); modifie(); }
    if (b.hasAttribute('data-supprimer')) supprimer(choix);
});

function majListe() {
    const ol = $('liste');
    ol.innerHTML = '';
    if (!S.evenements.length) ol.innerHTML = '<li><span>Aucun événement : choisissez un outil et cliquez sur la carte.</span></li>';
    for (const ev of S.evenements) {
        const li = document.createElement('li');
        li.classList.toggle('choisi', ev.id === choix);
        const couleur = ev.type === 'fumigene' ? COULEURS_FUMEE[ev.params?.couleur] || COULEURS_FUMEE.blanc
            : ev.type === 'unite' ? COULEUR_CAMP[ev.params.camp] : 'transparent';
        li.innerHTML = `<i class="pastille" style="background:${couleur}"></i><b>${texteHeure(ev.debut, false)}</b>`
            + `<span>${echapper(ev.libelle || ev.type)}${ev.type === 'jalon' ? ' (jalon)' : ''}</span>`;
        li.addEventListener('click', () => { choisir(ev.id); allerA(ev.debut); });
        ol.appendChild(li);
    }
}

// --- En-tête ------------------------------------------------------------------------
function majEntete() {
    $('titre').value = S.titre || '';
    $('date').value = S.date || '';
    $('debut').value = texteHeure(S.debut, false);
    $('fin').value = texteHeure(S.fin, false).replace(' (J+1)', '');
    $('vent-de').value = S.vent.de;
    $('vent-vitesse').value = S.vent.vitesse;
}
$('titre').addEventListener('change', () => { S.titre = $('titre').value.trim(); modifie(); });
$('date').addEventListener('change', () => { S.date = $('date').value || null; modifie(); });
$('vent-de').addEventListener('change', () => { S.vent.de = ((Number($('vent-de').value) % 360) + 360) % 360; modifie(); });
$('vent-vitesse').addEventListener('change', () => { S.vent.vitesse = Math.max(0, Number($('vent-vitesse').value)); modifie(); });
for (const nom of ['debut', 'fin']) {
    $(nom).addEventListener('change', () => {
        const s = lireHeure($(nom).value, nom === 'fin' ? S.debut : 0);
        if (s === null) { etat(`Heure illisible : ${$(nom).value}`); return majEntete(); }
        etat('');
        if (nom === 'debut') {
            // Tout le scénario glisse avec son début : les heures restent relatives.
            const d = s - S.debut;
            for (const ev of S.evenements) {
                ev.debut += d;
                if (ev.fin != null) ev.fin += d;
                for (const pt of ev.params?.trajet || []) pt.t += d;
            }
            S.debut = s; S.fin += d;
            temps += d;
        } else {
            S.fin = Math.max(s, S.debut + 60);
        }
        modifie();
    });
}

$('b-nouveau').addEventListener('click', () => {
    if (S.evenements.length && !confirm('Vider le brouillon ? Exportez-le d’abord pour le garder.')) return;
    S = nouveauScenario();
    temps = S.debut;
    choisir(null);
    modifie();
});
$('b-publie').addEventListener('click', async () => {
    const s = await lirePublie();
    if (!s) return etat('Aucun scénario publié avec ce site.');
    if (S.evenements.length && !confirm('Remplacer le brouillon par le scénario publié ?')) return;
    ouvrir(s);
});
$('b-importer').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { ouvrir(verifierScenario(JSON.parse(await f.text()))); etat(''); }
    catch (err) { etat(`${f.name} : ${err.message}`); }
});
$('b-exporter').addEventListener('click', () => {
    const lien = document.createElement('a');
    lien.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }));
    lien.download = 'scenario.json';
    lien.click();
    setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
});
{
    const p = new URLSearchParams(location.search);
    p.set('scenario', 'brouillon');
    $('b-3d').href = `app.html?${p}`;
}

// --- Frise --------------------------------------------------------------------------
const curseur = $('frise-curseur');
function majFrise() {
    curseur.min = S.debut;
    curseur.max = S.fin;
    const reperes = $('frise-reperes'), duree = S.fin - S.debut || 1;
    reperes.textContent = '';
    for (const ev of S.evenements) {
        const r = document.createElement('button');
        r.type = 'button';
        r.className = `repere ${ev.type}`;
        r.dataset.t = ev.debut;
        r.style.left = `${(100 * (ev.debut - S.debut) / duree).toFixed(2)}%`;
        if (ev.fin > ev.debut) r.style.width = `${(100 * (ev.fin - ev.debut) / duree).toFixed(2)}%`;
        r.title = `${texteHeure(ev.debut, false)} · ${ev.libelle || ev.type}`;
        r.addEventListener('click', () => { choisir(ev.id); allerA(ev.debut); });
        reperes.appendChild(r);
    }
    allerA(temps);
}
function allerA(t) {
    temps = Math.min(Math.max(t, S.debut), S.fin);
    curseur.value = temps;
    $('frise-heure').textContent = texteHeure(temps);
    for (const r of $('frise-reperes').children) r.classList.toggle('passe', Number(r.dataset.t) <= temps);
    dessiner();
}
curseur.addEventListener('input', () => allerA(Number(curseur.value)));
$('frise-moins').addEventListener('click', () => allerA(Math.round(temps) - 60));
$('frise-plus').addEventListener('click', () => allerA(Math.round(temps) + 60));
$('frise-lecture').addEventListener('click', () => {
    if (!enLecture && temps >= S.fin) allerA(S.debut);
    enLecture = !enLecture;
    $('frise-lecture').textContent = enLecture ? '❚❚' : '▶';
});
let precedent = performance.now();
requestAnimationFrame(function avancer(maintenant) {
    const dt = Math.min((maintenant - precedent) / 1000, 0.1);
    precedent = maintenant;
    if (enLecture && S) {
        allerA(temps + dt * Number($('frise-vitesse').value));
        if (temps >= S.fin) $('frise-lecture').click();
    }
    requestAnimationFrame(avancer);
});

// --- Ouverture -----------------------------------------------------------------------
async function lirePublie() {
    try {
        const r = await fetch('scenario.json', { cache: 'no-cache' });
        return r.ok ? verifierScenario(await r.json()) : null;
    } catch (e) { return null; }
}

function ouvrir(s) {
    S = s;
    S.vent ??= { de: 270, vitesse: 3 };
    S.points ??= {};
    for (const ev of S.evenements) if (ev.type === 'unite') {
        ev.params ??= {};
        ev.params.trajet ??= ev.lat != null ? [{ t: ev.debut, lat: ev.lat, lon: ev.lon }] : [];
        if (!ev.params.trajet.length) S.evenements = S.evenements.filter(e => e !== ev);
    }
    temps = S.debut;
    choisir(null);
    modifie();
}

async function demarrer() {
    choisirOutil('selection');
    ortho.onload = () => { orthoPrete = true; dessiner(); };
    ortho.onerror = () => etat('Orthophoto de la scène introuvable : ouvrez d’abord la vue 3D de ce point.');
    ortho.src = `api/ortho?${REQUETE}`;
    let brouillon = null;
    try { brouillon = JSON.parse(localStorage.getItem(CLE_BROUILLON) || 'null'); } catch (e) { /* illisible : ignoré */ }
    try { brouillon = brouillon && verifierScenario(brouillon); } catch (e) { brouillon = null; }
    ouvrir(brouillon || await lirePublie() || nouveauScenario());
    dimensionner();
    cadrer();
    dessiner();
}
new ResizeObserver(dimensionner).observe(toile);
demarrer();

/** Pour les essais. */
window.editeurScenario = () => ({ scenario: S, temps, choix, outil, vue: { ...vue } });
