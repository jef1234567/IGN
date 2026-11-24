// Fige une scène de Vue 3D IGN en site statique (GitHub Pages ou PC hors réseau).
//
// Ouvre la page du serveur local dans Chrome, enregistre toutes les réponses
// reçues (API du serveur, three.js, tuiles et relief de l'IGN), puis écrit :
//   site/app.html            la page de la scène (vue3d/static/index.html)
//   site/static/...          ses scripts et styles
//   site/data/<hash>         chaque réponse enregistrée
//   site/manifeste.json      adresse demandée -> [fichier, type]
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
let octets = 0;
const cleDe = u => (u.startsWith(base) ? u.slice(base.length) : u).split('#')[0];

const navigateur = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: 'new',
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
});

console.log('Ouverture de', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('attente').hidden
                             || /indisponible/.test(document.getElementById('attente').textContent),
                           { timeout: 40 * 60 * 1000, polling: 2000 });
const attente = await page.evaluate(() => document.getElementById('attente').textContent);
if (!(await page.evaluate(() => document.getElementById('attente').hidden))) {
  throw new Error('Scène indisponible : ' + attente);
}
console.log('Scène affichée, attente des couches…');
// Toits de roofer : bouton présent seulement si le service les a.
const avecRoofer = await page.waitForFunction(() => !document.getElementById('t-roofer').hidden,
                                              { timeout: 120000 }).then(() => true, () => false);
if (avecRoofer) {
  console.log('Calcul des toits roofer…');
  await page.evaluate(() => document.getElementById('t-roofer').click());
  await new Promise(r => setTimeout(r, 5000));
  await page.waitForFunction(() => document.getElementById('etat-roofer').hidden,
                             { timeout: 40 * 60 * 1000, polling: 3000 }).catch(() => console.log('roofer : délai dépassé'));
  console.log('roofer :', await page.evaluate(() => document.getElementById('etat-roofer').textContent || 'ok'));
} else console.log('roofer absent');
// Les couches à part (nuage, ouvrages, monuments, horizon) arrivent après.
await page.waitForNetworkIdle({ idleTime: 15000, timeout: 20 * 60 * 1000 }).catch(() => {});
await new Promise(r => setTimeout(r, 10000));
await page.screenshot({ path: path.join(sortie, 'apercu.png') });
await navigateur.close();

// La page et ses fichiers.
fs.cpSync('vue3d/static', path.join(sortie, 'static'), { recursive: true });
// Les toits de roofer s'affichent d'office dans la version figée.
const auto = `<script>(function(){const t=setInterval(()=>{const b=document.getElementById('t-roofer');
if(b&&!b.hidden){clearInterval(t);if(!b.classList.contains('on'))b.click();}},1000);setTimeout(()=>clearInterval(t),120000);})();</script>`;
fs.writeFileSync(path.join(sortie, 'app.html'),
  fs.readFileSync('vue3d/static/index.html', 'utf8').replace('</body>', (avecRoofer ? auto : '') + '</body>'));
fs.copyFileSync(path.join(ICI, 'sw.js'), path.join(sortie, 'sw.js'));
const point = new URL(url).search;
fs.writeFileSync(path.join(sortie, 'index.html'),
  fs.readFileSync(path.join(ICI, 'entree.html'), 'utf8').replace('__POINT__', point));
fs.copyFileSync(path.join(ICI, 'servir.ps1'), path.join(sortie, 'servir.ps1'));
fs.copyFileSync(path.join(ICI, 'LISEZMOI.txt'), path.join(sortie, 'LISEZMOI.txt'));
fs.writeFileSync(path.join(sortie, '.nojekyll'), '');
fs.writeFileSync(path.join(sortie, 'manifeste.json'), JSON.stringify(manifeste));
console.log(`${Object.keys(manifeste).length} réponses, ${(octets / 1e6).toFixed(1)} Mo`);
