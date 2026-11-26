// Coordonnées militaires : UTM sur WGS 84 et carroyage MGRS, sans
// bibliothèque. La série de Krüger (Snyder, « Map Projections — A Working
// Manual », 1987, p. 61) donne le millimètre à moins de 3° du méridien
// central, bien plus que le mètre affiché ; vérifiée contre pyproj
// (outils/verifier-mgrs.mjs).
//
// Les lettres des carrés de 100 km suivent le schéma « AA » de WGS 84 :
// colonnes par jeu de huit selon la zone, lignes décalées de F dans les zones
// paires.

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const BANDES = 'CDEFGHJKLMNPQRSTUVWXX';
const COLONNES = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const LIGNES = 'ABCDEFGHJKLMNPQRSTUV';

/** Zone UTM d'un point, exceptions de la Norvège et du Svalbard comprises. */
export function zoneUtm(lon, lat) {
    let z = Math.floor((lon + 180) / 6) + 1;
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
    if (lat >= 72 && lat < 84) {
        if (lon >= 0 && lon < 9) z = 31;
        else if (lon >= 9 && lon < 21) z = 33;
        else if (lon >= 21 && lon < 33) z = 35;
        else if (lon >= 33 && lon < 42) z = 37;
    }
    return Math.min(z, 60);
}

/** { zone, est, nord } en mètres ; null hors du domaine UTM (80° S à 84° N). */
export function versUtm(lon, lat) {
    if (!(lat >= -80 && lat < 84)) return null;
    const zone = zoneUtm(lon, lat);
    const phi = lat * Math.PI / 180;
    const dl = (lon - (zone * 6 - 183)) * Math.PI / 180;
    const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
    const N = A / Math.sqrt(1 - E2 * s * s);
    const T = t * t, C = EP2 * c * c, Aa = c * dl;
    const M = A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
        - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
        + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
        - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));
    const est = 500000 + K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
        + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120);
    let nord = K0 * (M + N * t * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
    if (lat < 0) nord += 10000000;
    return { zone, est, nord };
}

/** « 31U FR 12345 67890 » au mètre ; null hors du domaine UTM. */
export function versMgrs(lon, lat) {
    const u = versUtm(lon, lat);
    if (!u) return null;
    const bande = BANDES[Math.floor((lat + 80) / 8)];
    const colonne = COLONNES[(u.zone - 1) % 3][Math.floor(u.est / 100000) - 1];
    const ligne = LIGNES[(Math.floor(u.nord / 100000) + (u.zone % 2 ? 0 : 5)) % 20];
    const cinq = v => String(Math.floor(v % 100000)).padStart(5, '0');
    return `${u.zone}${bande} ${colonne}${ligne} ${cinq(u.est)} ${cinq(u.nord)}`;
}

/** Azimut vrai d'un écart (est, nord) en mètres, en millièmes OTAN (6 400 au tour). */
export function azimutMilliemes(de, dn) {
    return ((Math.atan2(de, dn) / (2 * Math.PI)) * 6400 + 6400) % 6400;
}

/**
 * Convergence du méridien en millièmes : l'angle du nord vrai au nord du
 * carroyage UTM, positif à l'est du méridien central. Un azimut lu sur la
 * carte au carroyage vaut l'azimut vrai moins cette convergence (13 ‰ au
 * CENZUB, 3,97° E, à 1° du méridien central de la zone 31).
 */
export function convergenceMilliemes(lon, lat) {
    const dl = (lon - (zoneUtm(lon, lat) * 6 - 183)) * Math.PI / 180;
    return Math.atan(Math.tan(dl) * Math.sin(lat * Math.PI / 180)) * 3200 / Math.PI;
}
