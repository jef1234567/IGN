// Vérifie js/commun/tir.js, le tir indirect d'instruction : que les coups
// tirés suivent bien la loi annoncée aux stagiaires (la moitié dans ±1 EP,
// la moitié dans l'ellipse, presque tout dans ±4 EP), qu'une graine rejoue la
// même salve, et que les axes de la scène sont les bons. Rien à installer.
//
//   node outils/verifier-tir.mjs
import {
    ARMES, BANDES, EP_EN_SIGMA, ELLIPSE_50_EN_EP, epDecole, horsDePortee,
    tirerCoups, dansEllipse50, parBandes, versScene, trajectoire, pointDeChute, allongement,
} from '../vue3d/static/js/commun/tir.js';

let echecs = 0;
const verifier = (bon, texte) => { if (!bon) echecs++; console.log(`${bon ? 'ok ' : 'ÉCHEC'} ${texte}`); };
const proche = (a, b, tol) => Math.abs(a - b) <= tol;

// 200 000 coups : l'écart-type d'une proportion de 50 % y est de 0,11 %.
const N = 200000, epP = 40, epD = 12;
const coups = tirerCoups(N, epP, epD, 1234);
const part = f => coups.filter(f).length / N;
verifier(proche(part(c => Math.abs(c.portee) <= epP), 0.5, 0.005), `±1 EP en portée : ${(100 * part(c => Math.abs(c.portee) <= epP)).toFixed(2)} % (50 %)`);
verifier(proche(part(c => Math.abs(c.direction) <= epD), 0.5, 0.005), `±1 EP en direction : ${(100 * part(c => Math.abs(c.direction) <= epD)).toFixed(2)} % (50 %)`);
verifier(proche(part(c => dansEllipse50(c, epP, epD)), 0.5, 0.005), `ellipse de la moitié : ${(100 * part(c => dansEllipse50(c, epP, epD))).toFixed(2)} % (50 %)`);
verifier(proche(part(c => Math.abs(c.portee) <= 4 * epP), 0.993, 0.003), `±4 EP en portée : ${(100 * part(c => Math.abs(c.portee) <= 4 * epP)).toFixed(2)} % (99,3 %)`);
const bandes = parBandes(coups, epP).map(n => 100 * n / N / 2);
BANDES.forEach((attendu, i) => verifier(proche(bandes[i], attendu, 0.8), `bande ${i + 1} d'un côté : ${bandes[i].toFixed(1)} % (${attendu} %)`));
verifier(proche(ELLIPSE_50_EN_EP, 1.7456, 1e-4), `demi-axe de l'ellipse : ${ELLIPSE_50_EN_EP.toFixed(4)} EP`);
verifier(proche(EP_EN_SIGMA, 0.6745, 1e-4), `EP = ${EP_EN_SIGMA.toFixed(4)} écart-type`);

// Même graine, même salve ; autre graine, autre salve.
const a = tirerCoups(5, epP, epD, 7), b = tirerCoups(5, epP, epD, 7), c = tirerCoups(5, epP, epD, 8);
verifier(JSON.stringify(a) === JSON.stringify(b), 'même graine, même salve');
verifier(JSON.stringify(a) !== JSON.stringify(c), 'autre graine, autre salve');

// Axes : x vers l'est, z vers le sud. Tir plein nord : plus long = vers le
// nord (z négatif), à droite = vers l'est. Tir plein est : plus long = est,
// à droite = sud.
const nord = versScene(100, 10, 0), est = versScene(100, 10, Math.PI / 2);
verifier(proche(nord.dx, 10, 1e-9) && proche(nord.dz, -100, 1e-9), `tir au nord : (${nord.dx.toFixed(1)}, ${nord.dz.toFixed(1)})`);
verifier(proche(est.dx, 100, 1e-9) && proche(est.dz, 10, 1e-9), `tir à l'est : (${est.dx.toFixed(1)}, ${est.dz.toFixed(1)})`);

// Portées et EP d'école.
const caesar = ARMES.find(x => x.id === 'caesar'), mo81 = ARMES.find(x => x.id === 'mo81');
verifier(horsDePortee(caesar, 3000) && !horsDePortee(caesar, 20000) && horsDePortee(caesar, 45000), 'CAESAR : 4,5 à 40 km');
verifier(!horsDePortee(mo81, 2000) && horsDePortee(mo81, 6000), 'mortier 81 : jusqu’à 5,6 km');
const ep = epDecole(caesar, 6000);
verifier(ep.portee === 15 && ep.direction === 4, `CAESAR à 6 km : EP ${ep.portee} m et ${ep.direction} m (exemple du FM 6-40 : 15 et 4)`);

// La trajectoire stylisée arrive au point voulu, avec l'angle voulu.
{
    const h = trajectoire(1000, 40, 65), e = 1e-3;
    verifier(proche(h(1000), 40, 1e-9) && proche((h(1000 + e) - h(1000 - e)) / (2 * e), -Math.tan(65 * Math.PI / 180), 1e-6),
        'trajectoire : arrivée à 1 000 m, 40 m plus haut, chute de 65°');
}
// La pente : sur un versant plan qui passe par l'objectif (plaine au niveau
// de la pièce jusqu'à 200 m avant), la dispersion mesurée au sol doit
// s'allonger comme le dit la formule du document de conception, à la
// courbure de la parabole près.
for (const [chute, alpha, D] of [[30, 15, 3000], [70, 15, 1000], [30, -15, 3000], [65, 20, 1500]]) {
    const ta = Math.tan(alpha * Math.PI / 180);
    const sol = s => (s < D - 200 ? 0 : -ta * (s - D));
    const ecarts = [-40, -20, 20, 40];
    const chutes = ecarts.map(p => pointDeChute(D + p, 0, chute, s => sol(s), 1).s - D);
    const mesure = (chutes[3] - chutes[0]) / (ecarts[3] - ecarts[0]), attendu = allongement(chute, alpha);
    verifier(proche(mesure, attendu, 0.03 * attendu), `pente ${alpha}°, chute ${chute}° : ×${mesure.toFixed(3)} mesuré, ×${attendu.toFixed(3)} par la formule`);
}
verifier(proche(allongement(30, 15), 1.866, 1e-3) && proche(allongement(30, -15), 0.683, 1e-3)
    && proche(allongement(70, 15), 1.108, 1e-3) && proche(allongement(70, -15), 0.911, 1e-3),
    'exemples du document : ×1,87 et ×0,68 à 30°, ×1,11 et ×0,91 à 70°');
verifier(allongement(30, 30) === null && allongement(30, 40) === null, 'versant plus raide que la chute : angle mort');
// Une crête de 250 m à mi-chemin (un tir tendu à 10° culmine à D tan 10° / 4 = 176 m) arrête un tir tendu, pas un tir courbe.
{
    const D = 4000, crete = s => (Math.abs(s - 2000) < 50 ? 250 : 0);
    const tendu = pointDeChute(D, 0, 10, crete, 2), courbe = pointDeChute(D, 0, 65, crete, 2);
    verifier(tendu.s < 2100 && proche(courbe.s, D, 1), `crête à mi-chemin : tir tendu arrêté à ${tendu.s.toFixed(0)} m, tir courbe à ${courbe.s.toFixed(0)} m`);
}

if (echecs) { console.log(`${echecs} échec(s)`); process.exit(1); }
console.log('tout est bon');
