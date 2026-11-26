"""Référence indépendante : la ligne de vue sur le relief vrai (monde.py),
pas à pas de 1 m, et le verdict de la page comparé."""
import json, math, sys
from monde import xy, sol, BATI, dans_scene, R_APP, LON0, LAT0, MLON, MLAT

def sol_eff(x, y):
    lon, lat = LON0 + x / MLON, LAT0 + y / MLAT
    z = sol(x, y)
    if BATI[0] <= x <= BATI[1] and BATI[2] <= y <= BATI[3]:
        z = max(z, BATI[4])
    return z if dans_scene(lon, lat) else z - (x * x + y * y) / (2 * R_APP)

def marge(A, B):
    """Plus petit écart (m) de la droite au-dessus du sol, 3 m des bouts exclus ; et la longueur."""
    ax, ay = xy(A['lon'], A['lat']); bx, by = xy(B['lon'], B['lat'])
    za = sol_eff(ax, ay) + A['h']; zb = sol_eff(bx, by) + B['h']
    L = math.hypot(bx - ax, by - ay)
    m = math.inf
    s = 3.0
    while s < L - 3:
        t = s / L
        m = min(m, za + (zb - za) * t - sol_eff(ax + (bx - ax) * t, ay + (by - ay) * t))
        s += 1.0
    return m, L

import os
d = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'page.json')))
def bilan(nom, cas):
    total = len(cas); net = [c for c in cas if not c[2]]
    faux = [c for c in net if c[0] != c[1]]
    tout_faux = [c for c in cas if c[0] != c[1]]
    print(f"{nom:13s}: {total} cas, {len(tout_faux)} désaccords ({100*len(tout_faux)/total:.1f} %) ; "
          f"hors des {total-len(net)} rasants (|marge| < 0,5 m + 2 ‰) : {len(faux)} ({100*len(faux)/max(len(net),1):.1f} %)")
    return faux

def juger(paires, verdicts):
    out = []
    for (A, B), v in zip(paires, verdicts):
        m, L = marge(A, B)
        out.append((m > 0, v, abs(m) < 0.5 + 0.002 * L, m, L))
    return out

lv = juger(d['paires'], d['ldv'])
gr = juger(d['paires'], d['grille'])
ca = []
for y, v in zip(d['yeux'], d['carte']):
    ca += juger([(y['O'], c) for c in y['cibles']], v)
vus = sum(c[0] for c in lv)
print(f"Référence : {vus} lignes de vue dégagées sur {len(lv)}")
for nom, cas in (('ligne de vue', lv), ('grille', gr), ('carte cubique', ca)):
    for c in bilan(nom, cas)[:5]:
        print(f"    référence {'vu' if c[0] else 'masqué'}, page {'vu' if c[1] else 'masqué'}, marge {c[3]:+.2f} m sur {c[4]:.0f} m")

for h, m in d['mat'].items():
    cas = juger([(m['O'], c) for c in m['cibles']], m['carte'])
    faux = [c for c in cas if c[0] != c[1] and not c[2]]
    print(f"Griffon 80 m derrière un talus de 5 m, optique à {h} m : page {sum(c[1] for c in cas)} cibles vues sur 60, référence {sum(c[0] for c in cas)}, désaccords hors rasants : {len(faux)}")

# Combien de lignes masquées le sont au-delà de la scène : ce que la page ignorait avant le relief de calcul.
def masque_dehors(A, B):
    ax, ay = xy(A['lon'], A['lat']); bx, by = xy(B['lon'], B['lat'])
    za = sol_eff(ax, ay) + A['h']; zb = sol_eff(bx, by) + B['h']
    L = math.hypot(bx - ax, by - ay); s = 3.0
    while s < L - 3:
        t = s / L; x = ax + (bx - ax) * t; y = ay + (by - ay) * t
        if za + (zb - za) * t < sol_eff(x, y):
            return not dans_scene(LON0 + x / MLON, LAT0 + y / MLAT)
        s += 1.0
    return False
n = sum(masque_dehors(A, B) for A, B in d['paires'])
print(f"Lignes masquées par un relief hors de la scène : {n} sur {len(d['paires'])}")
