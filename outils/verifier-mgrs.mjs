// Vérifie js/commun/mgrs.js contre des références indépendantes, gardées
// ci-dessous : UTM au centimètre près de pyproj (EPSG:326xx/327xx), MGRS au
// mètre du paquet Python mgrs (GeoTrans de la NGA), relevés le 26 novembre
// 2026. Rien à installer pour la relancer.
//
//   node outils/verifier-mgrs.mjs
import { versUtm, versMgrs, azimutMilliemes, convergenceMilliemes } from '../vue3d/static/js/commun/mgrs.js';

// [lon, lat, zone, est, nord, mgrs attendu]
const REFERENCES = [
  [3.9665, 49.5454, 31, 569916.64, 5488536.92, '31U EQ 69916 88536'],   // CENZUB
  [2.2945, 48.8584, 31, 448252.00, 5411954.91, '31U DQ 48252 11954'],   // tour Eiffel
  [6.45, 43.7, 32, 294525.52, 4841713.45, '32T KP 94525 41713'],        // Canjuers
  [-4.4861, 48.3904, 30, 389984.03, 5360759.93, '30U UU 89984 60759'],  // Brest
  [5.2003, 43.9116, 31, 676670.52, 4864407.83, '31T FJ 76670 64407'],   // Gordes
  [5.32, 60.39, 32, 297230.22, 6700510.18, '32V KN 97230 00510'],       // Bergen, exception 32V
  [151.21, -33.87, 56, 334435.71, 6250816.40, '56H LH 34435 50816'],    // Sydney, hémisphère sud
];
let echecs = 0;
for (const [lon, lat, zone, est, nord, mgrs] of REFERENCES) {
  const u = versUtm(lon, lat), m = versMgrs(lon, lat);
  const ecart = Math.hypot(u.est - est, u.nord - nord);
  const bon = u.zone === zone && ecart < 0.02 && m === mgrs;
  if (!bon) echecs++;
  console.log(`${bon ? 'ok ' : 'ÉCHEC'} ${lon},${lat} → ${m} (attendu ${mgrs}), écart UTM ${ecart.toFixed(3)} m`);
}
for (const [de, dn, attendu] of [[0, 1, 0], [1, 0, 1600], [0, -1, 3200], [-1, 0, 4800], [1, 1, 800]]) {
  const v = azimutMilliemes(de, dn);
  if (Math.abs(v - attendu) > 1e-9) { echecs++; console.log(`ÉCHEC azimut (${de}, ${dn}) = ${v}, attendu ${attendu}`); }
}
// Convergence au CENZUB : le nord vrai y a un azimut au carroyage de
// −13,075 ‰ (pyproj, deux points à 0,001° l'un de l'autre).
if (Math.abs(convergenceMilliemes(3.9665, 49.5454) - 13.075) > 0.01) { echecs++; console.log('ÉCHEC convergence'); }
if (echecs) { console.error(`${echecs} écart(s)`); process.exit(1); }
console.log('MGRS conforme.');
