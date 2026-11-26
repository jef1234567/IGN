# Audit des calculs de vue : la scène synthétique servie à la page.
import json, math, sys
import numpy as np
import os
ICI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ICI, '..', '..'))
sys.path.insert(0, ICI)
from vue3d.relief import _quantifier
lat0, lon0 = 49.5454, 3.9665
demi = 500 / 111320
w, s, e, n = lon0 - demi, lat0 - demi, lon0 + demi, lat0 + demi
N = 257
mlon = 111320 * math.cos(math.radians(lat0))
xs = np.linspace((w - lon0) * mlon, (e - lon0) * mlon, N)
ys = np.linspace((n - lat0) * 111320, (s - lat0) * 111320, N)   # ligne 0 au nord
X, Y = np.meshgrid(xs, ys)
# Une crête nord-sud de 25 m en x = 0, large de 60 m ; le terrain penche de 10 m vers l'est.
from monde import sol
Z = np.vectorize(sol)(X, Y)
relief = _quantifier(Z, np.zeros_like(Z, bool), w, s, e, n)
scene = {"version": 16, "bbox": [w, s, e, n], "batiments": {"features": []}, "toits": [], "routes": None,
         "constructions": [], "houppiers": [], "masses": [], "vegetation": {}, "relief": relief,
         "anneau": None, "eau": None, "lignes": None}
# Un bâtiment de 12 m, 20 m × 20 m, à 150 m à l'ouest du point.
scene['batiments'] = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {
    "cleabs": "BATIMENT0000000000000001", "hauteur": 12, "altitude_minimale_sol": 151.6,
    "altitude_minimale_toit": 163.6, "altitude_maximale_toit": 163.6, "nature": "Indifférenciée",
    "usage_1": "Résidentiel"}, "geometry": {"type": "Polygon", "coordinates": [[
    [3.9642848373903163, 49.5453101688825], [3.964561732716527, 49.5453101688825],
    [3.964561732716527, 49.5454898311175], [3.9642848373903163, 49.5454898311175],
    [3.9642848373903163, 49.5453101688825]]]}}]}
json.dump(scene, open(os.path.join(ICI, 'scene.json'), 'w'))
print(relief['width'], relief['zero_m'])
