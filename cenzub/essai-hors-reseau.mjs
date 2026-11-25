// Ouvre un dossier figé SANS réseau et vérifie que l'horizon vient du paquet
// de tuiles (outils/paquet_horizon.py) : Chrome ne résout que localhost.
//
//   python3 -m http.server -d site 8081 2> acces.log &
//   node cenzub/essai-hors-reseau.mjs http://localhost:8081/ site capture.png
//
// Sort en erreur si la scène ne s'affiche pas, ou si une tuile du paquet,
// prise loin de la scène, ne passe pas par le service worker.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const [url, site, capture = 'hors-reseau.png'] = process.argv.slice(2);
const zone = JSON.parse(fs.readFileSync(path.join(site, 'tuiles', 'zone.json'), 'utf8'));
const navigateur = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox',
         '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
});
const page = await navigateur.newPage();
await page.setViewport({ width: 1400, height: 850 });
const erreurs = [];
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
// Le cartouche d'attente est caché avant la demande de la scène : on attend
// donc les bâtiments ou le relief de la scène, puis on vérifie qu'aucune
// indisponibilité ne s'affiche (premier essai : « HTTP 404 » passé inaperçu).
await page.waitForFunction(() => location.pathname.endsWith('app.html'), { timeout: 120000 });
let attente = '', cache = 0;
for (let t = 0; t < 10 * 60 && cache < 30 && !/indisponible/.test(attente); t += 2) {
  await new Promise(r => setTimeout(r, 2000));
  attente = await page.evaluate(() => {
    const a = document.getElementById('attente');
    return a && !a.hidden ? a.textContent : '';
  });
  cache = attente ? 0 : cache + 2;
}
if (attente) {
  await page.screenshot({ path: capture });
  await navigateur.close();
  console.log('Scène pas affichée hors réseau :', attente);
  process.exit(1);
}
console.log('Scène affichée hors réseau');

// Une tuile de chaque sorte au bord du camp, loin de la scène.
const [o, s] = zone.zone.type === 'Polygon' ? zone.zone.coordinates[0][0] : zone.zone.coordinates[0][0][0];
const z = zone.zooms[1], n = 2 ** z;
const x = Math.floor((o + 180) / 360 * n);
const y = Math.floor((1 - Math.asinh(Math.tan(s * Math.PI / 180)) / Math.PI) / 2 * n);
const essais = [`api/tuile/ortho/${z}/${x}/${y}`];
const dossierAlti = path.join(site, 'tuiles', 'alti', '13');
const ligne = fs.readdirSync(dossierAlti)[0], colonne = fs.readdirSync(path.join(dossierAlti, ligne))[0].split('.')[0];
essais.push('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
  + '&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLE=normal&FORMAT=image/x-bil;bits=32'
  + `&TILEMATRIXSET=WGS84G_6_14&TILEMATRIX=13&TILEROW=${ligne}&TILECOL=${colonne}`);
const resultats = await page.evaluate(async urls => Promise.all(urls.map(async u => {
  try { const r = await fetch(u); return [u, r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]; }
  catch (e) { return [u, 'échec', e.message, 0]; }
})), essais);
await page.screenshot({ path: capture });
await navigateur.close();
let ok = true;
for (const [u, statut, type, octets] of resultats) {
  console.log(statut, type, octets, u.slice(0, 90));
  ok &&= statut === 200 && octets > 0;
}
console.log(`${erreurs.length} erreurs dans la console`, erreurs.slice(0, 5));
if (!ok) process.exit(1);
