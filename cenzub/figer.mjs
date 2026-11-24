// Fige une scène de Vue 3D IGN en site statique (GitHub Pages ou PC hors réseau).
//
// Ouvre la page du serveur local dans Chrome, enregistre toutes les réponses
// reçues (API du serveur, three.js, tuiles et relief de l'IGN), puis écrit :
//   site/app.html            la page de la scène (vue3d/static/index.html)
//   site/static/...          ses scripts et styles
//   site/data/<hash>         chaque réponse enregistrée
//   site/manifeste.json      adresse demandée -> [fichier, type]
//   site/scenario.json       le scénario, si SCENARIO le donne (cherché toujours)
//   site/sw.js, index.html   le service worker qui rejoue les réponses, et
//                            la page d'entrée qui l'installe
//
//   node cenzub/figer.mjs "http://localhost:8080/?lat=49.5454&lon=3.9665&zone=1700" site
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const url = process.argv[2];
const sortie = process.argv[3] || 'site';
const base = new URL('./', url).href;               // http://localhost:8080/
const ICI = path.dirname(new URL(import.meta.url).pathname);

fs.rmSync(sortie, { recursive: true, force: true });
fs.mkdirSync(path.join(sortie, 'data'), { recursive: true });

const manifeste = {};
let corpsRoofer = null;
let octets = 0;
const cleDe = u => (u.startsWith(base) ? u.slice(base.length) : u).split('#')[0];

const navigateur = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
  protocolTimeout: 60 * 60 * 1000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await navigateur.newPage();
await page.setViewport({ width: 1400, height: 850 });
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });

page.on('response', async reponse => {
  const req = reponse.request();
  if (req.method() !== 'GET' || reponse.status() !== 200) return;
  const u = reponse.url();
  // Les fichiers de la page elle-même sont copiés tels quels, pas enregistrés.
  if (u.startsWith(base) && !u.startsWith(base + 'api/')) return;
  if (u.startsWith('data:') || u.startsWith('blob:')) return;
  let corps;
  try { corps = await reponse.buffer(); } catch { return; }
  const type = reponse.headers()['content-type'] || 'application/octet-stream';
  const fichier = crypto.createHash('sha1').update(corps).digest('hex');
  fs.writeFileSync(path.join(sortie, 'data', fichier), corps);
  octets += corps.length;
  // Une redirection (tuile du serveur renvoyée vers l'IGN) répond aux deux adresses.
  for (const r of [...req.redirectChain(), req]) manifeste[cleDe(r.url())] = [fichier, type];
  if (u.includes('/api/roofer')) corpsRoofer = corps.toString('utf8', 0, 200);
});

console.log('Ouverture de', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
// Un refus de l'IGN (503 du serveur) n'est pas un échec : la page réessaie
// d'elle-même (« Nouvel essai dans 30 s »). Premier build de Canjuers, le
// 24 novembre 2026 : un 400 sporadique du WMS arrêtait tout à la première
// minute. Seule une indisponibilité sans nouvel essai arrête le figeage.
await page.waitForFunction(() => document.getElementById('attente').hidden
                             || (/indisponible/.test(document.getElementById('attente').textContent)
                                 && !/Nouvel essai/.test(document.getElementById('attente').textContent)),
                           { timeout: 40 * 60 * 1000, polling: 2000 });
const attente = await page.evaluate(() => document.getElementById('attente').textContent);
if (!(await page.evaluate(() => document.getElementById('attente').hidden))) {
  throw new Error('Scène indisponible : ' + attente);
}
console.log('Scène affichée, attente des couches…');
// Toits de roofer : la page les demande d'elle-même. Réponse nulle = pas de
// nuage LiDAR HD diffusé ici ; sinon le bouton paraît une fois le calcul fini.
console.log('Attente des toits roofer…');
for (let s = 0; s < 40 * 60 && corpsRoofer === null; s += 3) await new Promise(r => setTimeout(r, 3000));
corpsRoofer ??= '(pas de réponse)';
const avecRoofer = /batiments/.test(corpsRoofer) && await page.waitForFunction(
    () => !document.getElementById('t-roofer').hidden, { timeout: 120000 }).then(() => true, () => false);
console.log('Réponse roofer :', corpsRoofer.slice(0, 120));
console.log('roofer :', avecRoofer ? 'calculé' : 'absent',
            await page.evaluate(() => document.getElementById('t-roofer').title));
// Les couches à part (nuage, ouvrages, monuments, horizon) arrivent après.
await page.waitForNetworkIdle({ idleTime: 15000, timeout: 20 * 60 * 1000 }).catch(() => {});
await new Promise(r => setTimeout(r, 10000));
// Couches OpenStreetMap (Overpass souvent saturé) : redemandées jusqu'à réussite.
const requete = new URL(url).search.slice(1);
for (const couche of ['monuments', 'eoliennes', 'ortho']) {
  const cle = `api/${couche}?${requete}`;
  for (let essai = 1; essai <= 6 && !manifeste[cle]; essai++) {
    console.log(`${couche} : nouvel essai ${essai}`);
    await page.evaluate(c => { fetch(c).then(r => r.blob()).catch(() => {}); }, cle);
    await new Promise(r => setTimeout(r, 60000));
  }
  console.log(cle, manifeste[cle] ? 'enregistrée' : 'ABSENTE');
}
await page.screenshot({ path: path.join(sortie, 'apercu.png') });
await navigateur.close();

// La page et ses fichiers.
fs.cpSync('vue3d/static', path.join(sortie, 'static'), { recursive: true });
fs.copyFileSync('vue3d/static/index.html', path.join(sortie, 'app.html'));
fs.copyFileSync(path.join(ICI, 'sw.js'), path.join(sortie, 'sw.js'));
// Le calque scénario (SCENARIO : le scenario.json converti par
// outils/scenario.py) : copié à côté de la page. La page le cherche toujours,
// pour qu'on le change sans refiger la scène : remplacé dans le dossier hors
// réseau, ou republié par le workflow scenario.yml.
const scenario = process.env.SCENARIO;
if (scenario) fs.copyFileSync(scenario, path.join(sortie, 'scenario.json'));
// HORIZON=18 : l'horizon descend au zoom 18, pour un paquet de tuiles
// (outils/paquet_horizon.py --zoom-max 18) rangé ensuite dans le dossier.
const point = new URL(url).search + (avecRoofer ? '&roofer=1' : '') + '&scenario=scenario.json'
  + (process.env.HORIZON === '18' ? '&horizon=18' : '');
fs.writeFileSync(path.join(sortie, 'index.html'),
  fs.readFileSync(path.join(ICI, 'entree.html'), 'utf8').replace('__POINT__', point));
fs.copyFileSync(path.join(ICI, 'servir.ps1'), path.join(sortie, 'servir.ps1'));
fs.copyFileSync(path.join(ICI, 'LISEZMOI.txt'), path.join(sortie, 'LISEZMOI.txt'));
fs.writeFileSync(path.join(sortie, '.nojekyll'), '');
fs.writeFileSync(path.join(sortie, 'manifeste.json'), JSON.stringify(manifeste));
// Diagnostic des sources de hauteur de la scène.
for (const [cle, [f]] of Object.entries(manifeste)) if (cle.startsWith('api/scene') || cle.startsWith('api/nuage')) {
  const txt = fs.readFileSync(path.join(sortie, 'data', f), 'utf8');
  const sources = [...txt.matchAll(/"(source|couvert|lidar[a-z_]*)":\s*("[^"]*"|true|false|null)/g)].map(m => m[1] + '=' + m[2]);
  console.log(cle.split('?')[0], txt.length, 'octets', [...new Set(sources)].join(' '));
}
console.log(`${Object.keys(manifeste).length} réponses, ${(octets / 1e6).toFixed(1)} Mo`);
