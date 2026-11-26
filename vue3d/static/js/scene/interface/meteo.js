// Météo et vent au point de la scène, seulement avec du réseau : prévision
// d'Open-Meteo (modèles de Météo-France compris, données CC BY 4.0), lue au
// clic puis toutes les 15 min tant que le bouton reste allumé. Hors réseau,
// rien n'est gardé : une météo d'hier présentée comme celle du jour tromperait
// plus qu'elle n'aiderait, la page le dit et attend le retour du réseau.
import { CENTER } from '../socle/point.js';
import { POINTS_CARDINAUX } from '../socle/projection.js';
import { citerSource, majCredits } from './credits.js';

const $ = id => document.getElementById(id);
const bouton = $('t-meteo'), sortie = $('meteo-resultat'), note = $('meteo-note');
const RELIRE_MS = 15 * 60 * 1000;
const DELAI_MS = 10000;
const HEURES = 12;
const VARIABLES = 'temperature_2m,relative_humidity_2m,precipitation,cloud_cover,visibility,'
    + 'wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const HORAIRES = 'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_120m,wind_direction_120m';

let minuterie = null, montree = false;

const millièmes = deg => Math.round(deg * 6400 / 360) % 6400;
const cardinal = deg => POINTS_CARDINAUX[Math.round(deg / 45) % 8];
const arrondi = v => (v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('fr-FR'));

/** La flèche dit où le vent va ; le texte, d'où il vient, comme un bulletin. */
function fleche(deg, taille = 16) {
    const i = document.createElement('span');
    i.className = 'meteo-fleche';
    i.textContent = '↓';
    i.style.transform = `rotate(${deg}deg)`;
    i.style.fontSize = `${taille}px`;
    i.title = `vient du ${cardinal(deg)}, ${Math.round(deg)}° (${millièmes(deg)} ‰)`;
    return i;
}

function stat(nom, valeur) {
    const d = document.createElement('div');
    d.className = 'stat';
    const s = document.createElement('span'), b = document.createElement('b');
    s.textContent = nom;
    b.append(...[].concat(valeur));
    d.append(s, b);
    return d;
}

function afficher(m) {
    const c = m.current, h = m.hourly;
    sortie.textContent = '';
    sortie.append(
        stat('vent à 10 m', [fleche(c.wind_direction_10m, 18),
            ` ${arrondi(c.wind_speed_10m)} km/h, rafales ${arrondi(c.wind_gusts_10m)}`]),
        stat('vient du', `${cardinal(c.wind_direction_10m)}, ${Math.round(c.wind_direction_10m)}° (${millièmes(c.wind_direction_10m)} ‰)`),
        stat('température', `${c.temperature_2m.toLocaleString('fr-FR')} °C, humidité ${arrondi(c.relative_humidity_2m)} %`),
        stat('pluie', `${c.precipitation.toLocaleString('fr-FR')} mm, nuages ${arrondi(c.cloud_cover)} %`),
        stat('visibilité', c.visibility == null ? '—' : `${arrondi(c.visibility / 1000)} km`),
    );
    const table = document.createElement('table');
    table.className = 'meteo-heures';
    table.innerHTML = '<thead><tr><th>h</th><th>10 m</th><th>raf.</th><th>120 m</th><th>°C</th><th>pluie</th></tr></thead>';
    const corps = document.createElement('tbody');
    const maintenant = c.time.slice(0, 13);
    const debut = Math.max(0, h.time.findIndex(t => t.slice(0, 13) >= maintenant));
    for (let i = debut; i < Math.min(h.time.length, debut + HEURES); i++) {
        const tr = document.createElement('tr');
        const cellule = (...v) => { const td = document.createElement('td'); td.append(...v); tr.append(td); };
        cellule(h.time[i].slice(11, 13));
        cellule(fleche(h.wind_direction_10m[i], 12), ` ${arrondi(h.wind_speed_10m[i])}`);
        cellule(arrondi(h.wind_gusts_10m[i]));
        cellule(fleche(h.wind_direction_120m[i], 12), ` ${arrondi(h.wind_speed_120m[i])}`);
        cellule(arrondi(h.temperature_2m[i]));
        cellule(`${arrondi(h.precipitation_probability[i])} %`);
        corps.append(tr);
    }
    table.append(corps);
    sortie.append(table);
    note.textContent = `Prévision Open-Meteo à ${c.time.slice(11, 16)} (heure de Paris), au centre de la scène. Vents en km/h ; la flèche montre où va le vent.`;
}

function horsReseau(raison) {
    sortie.textContent = '';
    const d = document.createElement('div');
    d.className = 'meteo-hors-ligne';
    d.textContent = 'Pas de réseau : la météo n\'est pas disponible hors ligne.';
    sortie.append(d);
    note.textContent = `Elle s'affichera d'elle-même au retour du réseau, tant que le bouton reste allumé${raison ? ` (${raison})` : ''}.`;
    montree = false;
    majCredits();
}

async function lire() {
    if (!bouton.classList.contains('on')) return;
    if (navigator.onLine === false) return horsReseau();
    note.textContent = 'Lecture de la météo…';
    const [lon, lat] = CENTER;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + `&current=${VARIABLES}&hourly=${HORAIRES}&forecast_hours=${HEURES + 2}&timezone=Europe%2FParis&wind_speed_unit=kmh`;
    try {
        const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(DELAI_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const m = await r.json();
        if (!bouton.classList.contains('on')) return;
        afficher(m);
        montree = true;
        majCredits();
    } catch (e) {
        horsReseau(e.name === 'TimeoutError' ? 'pas de réponse en 10 s' : e.message);
    }
}

bouton.addEventListener('click', () => {
    const on = bouton.classList.toggle('on');
    sortie.hidden = !on;
    clearInterval(minuterie);
    if (on) {
        lire();
        minuterie = setInterval(lire, RELIRE_MS);
    } else {
        sortie.textContent = '';
        note.textContent = 'Seulement avec du réseau.';
        montree = false;
        majCredits();
    }
});
addEventListener('online', lire);
addEventListener('offline', () => bouton.classList.contains('on') && horsReseau());
citerSource('meteo', () => montree);
