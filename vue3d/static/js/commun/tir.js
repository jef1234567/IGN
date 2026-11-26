// Tir indirect, pour l'instruction : de quoi faire voir la dispersion d'une
// arme à des débutants, sur le terrain de la scène. Ce n'est pas un calcul de
// tir : aucune table de tir, aucun élément de tir, des écarts probables
// d'école que la page dit tels et laisse régler.
//
// Rien ici ne touche au DOM ni à three.js : outils/verifier-tir.mjs l'exécute
// sous Node.

// Une loi normale dépasse son écart probable (EP) une fois sur deux : EP =
// 0,6745 écart-type. C'est la définition du manuel public FM 6-40 (chap. 3,
// « Probable error is … an error that is exceeded as often as it is not »).
export const EP_EN_SIGMA = 0.6744897501960817;

// L'ellipse qui contient la moitié des coups (loi normale à deux dimensions) :
// demi-axes de √(2 ln 2) écarts-types, soit 1,7456 EP dans chaque axe.
export const ELLIPSE_50_EN_EP = Math.sqrt(2 * Math.LN2) / EP_EN_SIGMA;

// Les bandes du rectangle de dispersion, de 1 EP chacune, du centre vers le
// bord, d'un seul côté : 25 %, 16 %, 7 % et 2 % des coups, 4 EP de chaque
// côté contenant presque tout (99,3 %). Arrondis de la loi normale ; le
// FM 6-40 donne les cumuls 50, 82, 96 et 100 %.
export const BANDES = [25, 16, 7, 2];

// Les armes. Portées : celles des pages Wikipédia (anglaises), lues le
// 26 novembre 2026, seules sources ouvertes retenues :
//   LLR 81 mm : 3 100 m (obus modèle 1944), 5 600 m (munition spéciale).
//   MO 120 RT : 8,2 km, 13 km avec l'obus propulsé (PRPA).
//   CAESAR : 4,5 à 40 km avec l'obus ERFB, 55 km avec un obus propulsé.
// Les portées minimales des mortiers n'y figurent pas : aucune n'est imposée.
// Écarts probables, en part de la distance de tir : pour le CAESAR, l'exemple
// du FM 6-40 (un 155 mm à 6 000 m : 15 m en portée, 4 m en direction) ; pour
// les mortiers, aucune source ouverte trouvée, des valeurs d'école choisies
// pour que l'ellipse se voie, à régler dans la page.
export const ARMES = [
    {
        id: 'mo81', nom: 'Mortier 81 mm', porteeMin: 0, porteeMax: 5600,
        epPortee: 0.01, epDirection: 0.004, chutes: { courbe: 65 },
        source: 'Portée : Wikipédia, « LLR 81mm » (5 600 m avec munition spéciale, 3 100 m avec l’obus de 1944). EP : valeurs d’école.',
    },
    {
        id: 'mo120', nom: 'Mortier 120 mm', porteeMin: 0, porteeMax: 8200,
        epPortee: 0.01, epDirection: 0.004, chutes: { courbe: 65 },
        source: 'Portée : Wikipédia, « MO-120-RT » (8,2 km, 13 km avec obus propulsé). EP : valeurs d’école.',
    },
    {
        id: 'caesar', nom: 'CAESAR 155 mm', porteeMin: 4500, porteeMax: 40000,
        epPortee: 0.0025, epDirection: 0.0007, chutes: { tendue: 35, courbe: 65 },
        source: 'Portée : Wikipédia, « CAESAR » (4,5 à 40 km, obus ERFB). EP : ordre de grandeur de l’exemple du FM 6-40 (155 mm à 6 000 m).',
    },
];

// Angles de chute (degrés), valeurs d'école : un mortier ne tire que courbe,
// au-dessus de 45° ; un canon tire tendu (trajectoire basse) ou courbe.
export const TRAJECTOIRES = { tendue: 'tendue', courbe: 'courbe' };

// Sous 3 m, un EP ne se voit plus sur la carte ; c'est un plancher d'affichage.
export const EP_MIN = 3;

/** Les écarts probables d'école d'une arme à une distance (m) : { portee, direction }. */
export function epDecole(arme, distance) {
    return {
        portee: Math.max(EP_MIN, Math.round(arme.epPortee * distance)),
        direction: Math.max(EP_MIN, Math.round(arme.epDirection * distance)),
    };
}

/** Une raison de ne pas tirer à cette distance, ou null. */
export function horsDePortee(arme, distance) {
    if (distance > arme.porteeMax) return `trop loin : ${arme.nom} porte à ${(arme.porteeMax / 1000).toLocaleString('fr-FR')} km`;
    if (distance < arme.porteeMin) return `trop près : ${arme.nom} ne tire pas sous ${(arme.porteeMin / 1000).toLocaleString('fr-FR')} km`;
    return null;
}

/** Tirage pseudo-aléatoire répétable (mulberry32) : la même graine rejoue la même salve. */
export function alea(graine) {
    let a = graine >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * `n` coups autour du point moyen : { portee, direction } en mètres, écart en
 * portée (positif : plus long) et en direction (positif : à droite du tireur).
 * Deux lois normales indépendantes (Box-Muller), d'écarts-types EP / 0,6745.
 */
export function tirerCoups(n, epPortee, epDirection, graine) {
    const u = alea(graine), coups = [];
    const sp = epPortee / EP_EN_SIGMA, sd = epDirection / EP_EN_SIGMA;
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt(-2 * Math.log(1 - u())), t = 2 * Math.PI * u();
        coups.push({ portee: sp * r * Math.cos(t), direction: sd * r * Math.sin(t) });
    }
    return coups;
}

/** Vrai si le coup tombe dans l'ellipse de la moitié des coups. */
export function dansEllipse50(c, epPortee, epDirection) {
    const a = ELLIPSE_50_EN_EP * epPortee, b = ELLIPSE_50_EN_EP * epDirection;
    return (c.portee / a) ** 2 + (c.direction / b) ** 2 <= 1;
}

/** Les coups comptés par bande de 1 EP en portée, du centre vers le bord (4 bandes, au-delà dans la 5e). */
export function parBandes(coups, epPortee) {
    const n = [0, 0, 0, 0, 0];
    for (const c of coups) n[Math.min(4, Math.floor(Math.abs(c.portee) / epPortee))]++;
    return n;
}

/**
 * Un écart (portée, direction) en coordonnées de la scène, x vers l'est et z
 * vers le sud, pour un tir d'azimut `az` (radians, depuis le nord, sens des
 * aiguilles d'une montre) : { dx, dz }.
 */
export function versScene(portee, direction, az) {
    const s = Math.sin(az), c = Math.cos(az);
    // Dans l'axe : (sin az, −cos az) ; à droite du tireur : (cos az, sin az).
    return { dx: portee * s + direction * c, dz: -portee * c + direction * s };
}

/** Le contour d'une ellipse de demi-axes a (portée) et b (direction), en `n` points (portée, direction). */
export function contourEllipse(a, b, n = 72) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = 2 * Math.PI * i / n;
        pts.push({ portee: a * Math.cos(t), direction: b * Math.sin(t) });
    }
    return pts;
}

// --- Le relief (lot 2) -----------------------------------------------------------------
// La trajectoire est stylisée : une parabole dans le plan vertical du tir, qui
// part de la pièce et arrive au niveau de l'objectif avec l'angle de chute
// donné. Elle ne sert qu'à deux choses : savoir où chaque coup rencontre le
// sol vrai (une contre-pente allonge la zone de chute, une pente face au
// tireur la raccourcit), et si une crête l'arrête avant (angle mort). Ce
// n'est pas une trajectoire balistique : ni frottement de l'air, ni flèche
// réelle, et l'angle de chute est une valeur d'école.

const RAD = Math.PI / 180;

/**
 * La hauteur de la trajectoire au-dessus de la pièce à la distance s, pour
 * un point d'arrivée à D m et dy m au-dessus de la pièce, angle de chute
 * `chute` (degrés) : h(s) = a s + b s², h(D) = dy, h'(D) = −tan(chute).
 */
export function trajectoire(D, dy, chute) {
    const t = Math.tan(chute * RAD);
    const b = -(dy + D * t) / (D * D), a = -t - 2 * b * D;
    return s => a * s + b * s * s;
}

/**
 * Où la trajectoire rencontre le sol : `sol(s)` donne la hauteur du sol au-
 * dessus de la pièce à la distance s (null hors du relief chargé). On avance
 * pas à pas depuis la bouche, puis on resserre par dichotomie. Rend
 * { s, h }, ou null si le relief manque avant la rencontre.
 */
export function pointDeChute(D, dy, chute, sol, pas) {
    const h = trajectoire(D, dy, chute);
    // Les premiers mètres sont ignorés : le coup part de la pièce, posée au sol.
    let s0 = Math.min(10, D / 4), fin = 2 * D + 500;
    let g0 = sol(s0);
    if (g0 == null) return null;
    for (let s = s0 + pas; s <= fin; s += pas) {
        const g = sol(s);
        if (g == null) return null;
        if (h(s) <= g) {
            let lo = s0, hi = s;
            for (let k = 0; k < 30; k++) {
                const m = (lo + hi) / 2, gm = sol(m);
                if (gm != null && h(m) <= gm) hi = m; else lo = m;
            }
            return { s: hi, h: h(hi) };
        }
        s0 = s;
    }
    return null;
}

/**
 * L'allongement de la zone de chute sur une pente α (degrés) dans l'axe du
 * tir, pour un angle de chute ω : tan ω / (tan ω − tan α). α > 0 : le sol
 * descend en s'éloignant de la pièce (contre-pente), la zone s'allonge ;
 * α < 0 : il monte vers l'objectif (pente face au tireur), elle raccourcit.
 * null si α ≥ ω : le coup ne peut plus toucher ce versant, c'est un angle mort.
 */
export function allongement(chute, alpha) {
    if (alpha >= chute) return null;
    const t = Math.tan(chute * RAD);
    return t / (t - Math.tan(alpha * RAD));
}

/** L'écart-type d'une liste de nombres. */
export function ecartType(v) {
    const m = v.reduce((a, x) => a + x, 0) / v.length;
    return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
}
