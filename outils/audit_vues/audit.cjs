// Audit des calculs de vue : la page (ligne de vue, grille du bréchage, carte
// cubique) sur des paires tirées au hasard dans un monde synthétique ; le
// relief lui est servi en tuiles RGE ALTI fabriquées à partir de monde.py.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// three r160 tel que publié sur npm (npm pack three@0.160.0) : le réseau de l'essai est coupé.
const THREE_DIR = process.env.THREE_DIR || path.join(__dirname, 'node_modules', 'three');
const URL_PAGE = process.argv[2] || 'http://127.0.0.1:8766/?lat=49.5454&lon=3.9665';
const LAT0 = 49.5454, LON0 = 3.9665, MLAT = 111320, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const sol = (x, y) => 150 - 0.01 * x + 25 * Math.exp(-((x / 60) ** 2)) + 40 * Math.exp(-(((x - 900) / 120) ** 2))
    + 30 * Math.exp(-((x + 300) ** 2 + (y - 1200) ** 2) / 200 ** 2) + 5 * Math.exp(-(((x + 600) / 30) ** 2));
function tuileBil(niveau, ligne, colonne) {
    const p = 180 / 2 ** niveau / 256, v = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const lon = -180 + (colonne * 256 + i + 0.5) * p, lat = 90 - (ligne * 256 + j + 0.5) * p;
        v[j * 256 + i] = sol((lon - LON0) * MLON, (lat - LAT0) * MLAT);
    }
    return Buffer.from(v.buffer);
}
// Tirage reproductible.
let graine = 12345;
const hasard = () => ((graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648);
const point = (r, h) => {
    const x = (hasard() * 2 - 1) * r, y = (hasard() * 2 - 1) * r;
    return { lon: LON0 + x / MLON, lat: LAT0 + y / MLAT, h };
};
const OEILS = [0.5, 1.6, 2.6, 6.4], CIBLES = [0.5, 1.8, 3.0];
(async () => {
    const navigateur = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await navigateur.newPage({ viewport: { width: 1000, height: 700 } });
    const erreurs = [];
    page.on('pageerror', e => erreurs.push(e.message));
    await page.route('**/*', r => {
        const u = r.request().url();
        if (u.startsWith('https://cdn.jsdelivr.net/npm/three@0.160.0/')) {
            return r.fulfill({ body: fs.readFileSync(THREE_DIR + '/' + u.split('three@0.160.0/')[1]), contentType: 'text/javascript' });
        }
        if (u.includes('ELEVATION.ELEVATIONGRIDCOVERAGE')) {
            const q = new URL(u).searchParams;
            return r.fulfill({ body: tuileBil(+q.get('TILEMATRIX'), +q.get('TILEROW'), +q.get('TILECOL')), contentType: 'image/x-bil;bits=32' });
        }
        if (u.startsWith('http://127.0.0.1:8766/api/') && !u.includes('/api/scene')) return r.fulfill({ status: 404, body: '{}', contentType: 'application/json' });
        if (u.startsWith('http://127.0.0.1:8766/')) return r.continue();
        return r.abort();
    });
    await page.goto(URL_PAGE, { waitUntil: 'load' });
    await page.waitForFunction(async () => (await import('/static/js/scene/terrain/etat.js')).terrain !== null, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    // Paires : 400 lignes de vue sur 3 km de côté ; 8 yeux × 50 cibles pour la carte.
    const paires = [];
    for (let k = 0; k < 400; k++) paires.push([point(1500, OEILS[k % 4]), point(1500, CIBLES[k % 3])]);
    const yeux = [];
    for (let k = 0; k < 8; k++) {
        const O = point(1200, OEILS[k % 4]);
        yeux.push({ O, cibles: Array.from({ length: 50 }, (_, i) => point(1500, CIBLES[i % 3])) });
    }
    const t0 = Date.now();
    const ldv = await page.evaluate(async p => (await import('/static/js/scene/interface/mission.js')).ligneDeVueEssai(p), paires);
    const t1 = Date.now();
    const grille = await page.evaluate(async p => (await import('/static/js/scene/interface/brechage.js')).grilleEssai(p), paires);
    const t2 = Date.now();
    const carte = [];
    for (const y of yeux) carte.push(await page.evaluate(async ([O, c]) => (await import('/static/js/scene/interface/mission.js')).carteEssai(O, c), [y.O, y.cibles]));
    const t3 = Date.now();
    // Le mât : un Griffon 80 m derrière un talus de 5 m (x = −600 m, hors de la scène),
    // toit à 2,9 m puis mât levé à 6,4 m, et 60 cibles au sol au-delà, de 40 à 400 m du talus.
    const mat = {};
    for (const h of [2.9, 6.4]) {
        const O = { lon: LON0 - 680 / MLON, lat: LAT0 + 300 / MLAT, h };
        const cibles = Array.from({ length: 60 }, (_, i) => ({ lon: LON0 + (-560 + 6 * i) / MLON, lat: LAT0 + 300 / MLAT, h: 0.5 }));
        mat[h] = { O, cibles, carte: await page.evaluate(async ([O, c]) => (await import('/static/js/scene/interface/mission.js')).carteEssai(O, c), [O, cibles]) };
    }
    fs.writeFileSync(path.join(__dirname, 'page.json'), JSON.stringify({ paires, ldv, grille, yeux, carte, mat }));
    console.log(`ligne de vue ${t1 - t0} ms, grille ${t2 - t1} ms, carte ${t3 - t2} ms ; erreurs JS :`, erreurs);
    await navigateur.close();
})();
