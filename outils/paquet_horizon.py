"""Tuiles de l'horizon d'une zone, rangées pour la version hors réseau.

L'horizon de la page (vue3d/static/js/scene/terrain/horizon.js) drape
l'orthophoto (tuiles WMTS PM, zooms 9 à 17, 18 avec `&horizon=18`) sur les
altitudes natives du RGE ALTI (WMTS WGS84G, niveaux 6 à 14) : c'est lui qui
laisse le drone survoler un camp entier au-delà de la scène. Ce script lit
une fois, à l'IGN, les tuiles que l'horizon demandera au-dessus d'une zone,
et les range dans le dossier figé :

  <site>/tuiles/ortho/<z>/<x>/<y>.jpg
  <site>/tuiles/alti/<niveau>/<ligne>/<colonne>.bil
  <site>/tuiles/zone.json         zone, zooms, nombre de tuiles et octets

Le service worker (cenzub/sw.js) les sert avant d'aller au réseau.

Quelles tuiles : celles que l'horizon divise quand la caméra survole la zone.
Une tuile de zoom z se divise à moins de HORIZON_FINESSE (1,5) fois sa
largeur : ses filles, de zoom z + 1, sont lues à moins de 3 fois leur propre
largeur. Chaque zoom est donc lu sur la zone élargie de MARGE_LARGEURS fois
sa largeur de tuile (60 km au plus, le rayon de l'horizon). Les altitudes
sont celles que lit `altitudesTuile` pour chacune : niveau z − 5 borné à
[6, 14], la tuile et une maille de marge.

  python outils/paquet_horizon.py zone --osm Canjuers zone.geojson
  python outils/paquet_horizon.py compter zone.geojson [--zoom-max 18]
  python outils/paquet_horizon.py lire zone.geojson site [--zoom-max 18]

`zone` cherche dans OpenStreetMap (Overpass) le plus grand terrain militaire
dont le nom contient le texte donné, et écrit son contour en GeoJSON, avec
son centre. Une zone peut aussi être donnée en « ouest,sud,est,nord ».
"""

import concurrent.futures as cf
import json
import math
import os
import sys
import time

import requests
from shapely import affinity
from shapely.geometry import LineString, box, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.prepared import prep

ZOOM_MIN = 9                 # HORIZON_ZOOM_MIN
ZOOM_MAX = 17                # HORIZON_ZOOM_MAX, 18 avec `&horizon=18`
ALTI_MIN, ALTI_MAX = 6, 14   # ALTI_NIVEAU_MIN, ALTI_NIVEAU_MAX (commun/tuiles.js)
MAILLES = 32                 # HORIZON_MAILLES
MARGE_LARGEURS = 4
RAYON_MAX_M = 60000          # HORIZON_RAYON
M_PAR_DEGRE = 111320

URL_ORTHO = ("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
             "&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg"
             "&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}")
URL_ALTI = ("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
            "&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLE=normal&FORMAT=image/x-bil;bits=32"
            "&TILEMATRIXSET=WGS84G_6_14&TILEMATRIX={n}&TILEROW={r}&TILECOL={c}")
# Overpass répond souvent 502 ou 504 aux heures chargées : on passe au miroir suivant.
URLS_OVERPASS = ("https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter",
                 "https://overpass.private.coffee/api/interpreter")
FILS = 12                    # HORIZON_PARALLELE
ENTETES = {"User-Agent": "vue3d-paquet-horizon"}


# --- Zone ----------------------------------------------------------------------

def zone_osm(nom, urls=URLS_OVERPASS, tours=3):
    """Contour du plus grand terrain militaire OSM dont le nom contient `nom`."""
    requete = (f'[out:json][timeout:120];(way["landuse"="military"]["name"~"{nom}",i];'
               f'relation["landuse"="military"]["name"~"{nom}",i];'
               f'way["military"]["name"~"{nom}",i];relation["military"]["name"~"{nom}",i];);out geom;')
    erreurs = []
    for tour in range(tours):
        for url in urls:
            try:
                r = requests.post(url, data={"data": requete}, headers=ENTETES, timeout=180)
                r.raise_for_status()
                return plus_grand(r.json()["elements"])
            except (requests.RequestException, ValueError, KeyError) as e:
                # Une réponse vide n'est pas une preuve d'absence : le 24
                # novembre 2026, un miroir a rendu 0 élément pour Canjuers,
                # trouvé (346 km²) une heure plus tôt. On demande au suivant.
                erreurs.append(f"{url} : {e}")
        time.sleep(30 * (tour + 1))
    raise RuntimeError("Overpass indisponible :\n" + "\n".join(erreurs))


def plus_grand(elements):
    """Le plus grand polygone des éléments Overpass (`out geom`)."""
    polygones = []
    for el in elements:
        if el["type"] == "way" and len(el.get("geometry", [])) >= 4:
            lignes = [[(p["lon"], p["lat"]) for p in el["geometry"]]]
        elif el["type"] == "relation":
            lignes = [[(p["lon"], p["lat"]) for p in m["geometry"]]
                      for m in el.get("members", []) if m.get("role") in ("outer", "") and m.get("geometry")]
        else:
            continue
        p = unary_union(list(polygonize([LineString(l) for l in lignes if len(l) >= 2])))
        if not p.is_empty:
            polygones.append((p.area, p, el.get("tags", {}).get("name", "")))
    if not polygones:
        raise ValueError("aucun terrain militaire de ce nom dans OpenStreetMap")
    return max(polygones, key=lambda t: t[0])[1:]


def lire_zone(texte):
    """« ouest,sud,est,nord » ou un fichier GeoJSON (Feature ou géométrie)."""
    if os.path.exists(texte):
        with open(texte, encoding="utf-8") as f:
            g = json.load(f)
        return shape(g.get("geometry", g))
    o, s, e, n = (float(v) for v in texte.split(","))
    return box(o, s, e, n)


# --- Tuiles ----------------------------------------------------------------------

def tuile_pm(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(x), int(y)


def bornes_pm(x, y, z):
    """(ouest, sud, est, nord) d'une tuile PM, en degrés."""
    n = 2 ** z
    lat = lambda j: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * j / n))))
    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def elargir(zone, metres):
    """La zone élargie de `metres`, en degrés à la latitude de son centre."""
    c = zone.centroid
    kx = M_PAR_DEGRE * math.cos(math.radians(c.y))
    metrique = affinity.scale(zone, kx, M_PAR_DEGRE, origin=(0, 0))
    return affinity.scale(metrique.buffer(metres, quad_segs=8), 1 / kx, 1 / M_PAR_DEGRE, origin=(0, 0))


def tuiles_ortho(zone, zoom_max=ZOOM_MAX):
    """{z: [(x, y), …]} : les tuiles de l'horizon au-dessus de la zone."""
    lat = zone.centroid.y
    resultat = {}
    for z in range(ZOOM_MIN, zoom_max + 1):
        largeur = 2 * math.pi * 6378137 * math.cos(math.radians(lat)) / 2 ** z
        large = elargir(zone, min(MARGE_LARGEURS * largeur, RAYON_MAX_M))
        o, s, e, n = large.bounds
        (x0, y0), (x1, y1) = tuile_pm(o, n, z), tuile_pm(e, s, z)
        p = prep(large)
        resultat[z] = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)
                       if p.intersects(box(*bornes_pm(x, y, z)))]
    return resultat


def tuiles_alti_pour(z, x, y):
    """Tuiles d'altitudes que lit `altitudesTuile` (horizon.js) pour une tuile."""
    niveau = min(max(z - 5, ALTI_MIN), ALTI_MAX)
    p = 180 / 2 ** niveau / 256
    marge = 360 / 2 ** z / MAILLES
    o, s, e, n = bornes_pm(x, y, z)
    x0 = math.floor((o - marge + 180) / p - 0.5)
    x1 = math.floor((e + marge + 180) / p - 0.5) + 1
    y0 = math.floor((90 - n - marge) / p - 0.5)
    y1 = math.floor((90 - s + marge) / p - 0.5) + 1
    return {(niveau, ligne, colonne) for ligne in range(y0 >> 8, (y1 >> 8) + 1)
            for colonne in range(x0 >> 8, (x1 >> 8) + 1)}


def inventaire(zone, zoom_max=ZOOM_MAX):
    ortho = tuiles_ortho(zone, zoom_max)
    alti = set()
    for z, liste in ortho.items():
        for x, y in liste:
            alti |= tuiles_alti_pour(z, x, y)
    return ortho, sorted(alti)


# --- Lecture ---------------------------------------------------------------------

def lire(session, url, signature, essais=6):
    """Le corps de la tuile, None si l'IGN dit qu'elle n'existe pas (404)."""
    for essai in range(essais):
        try:
            r = session.get(url, timeout=60)
            if r.status_code == 404 and essai >= 2:
                return None
            if r.ok and r.content.startswith(signature):
                return r.content
        except requests.RequestException:
            pass
        # La Géoplateforme refuse par épisodes une tuile qui existe (tuiles.py).
        time.sleep(min(2 ** essai, 30))
    raise RuntimeError(f"tuile illisible après {essais} essais : {url}")


def telecharger(zone, site, zoom_max=ZOOM_MAX, fils=FILS):
    ortho, alti = inventaire(zone, zoom_max)
    taches = [(URL_ORTHO.format(z=z, x=x, y=y), os.path.join(site, "tuiles", "ortho", str(z), str(x), f"{y}.jpg"),
               b"\xff\xd8") for z, l in ortho.items() for x, y in l]
    taches += [(URL_ALTI.format(n=n, r=r, c=c), os.path.join(site, "tuiles", "alti", str(n), str(r), f"{c}.bil"),
                b"") for n, r, c in alti]
    print(f"{len(taches)} tuiles à lire ({sum(map(len, ortho.values()))} d'orthophoto, {len(alti)} d'altitudes)")
    session = requests.Session()
    session.headers.update(ENTETES)
    session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=fils))
    compte = {"lues": 0, "deja": 0, "absentes": 0, "octets": 0}

    def une(t):
        url, chemin, signature = t
        if os.path.exists(chemin):
            return "deja", os.path.getsize(chemin)
        corps = lire(session, url, signature)
        if corps is None:
            return "absentes", 0
        if signature == b"" and len(corps) != 256 * 256 * 4:
            raise RuntimeError(f"altitudes tronquées ({len(corps)} octets) : {url}")
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        with open(chemin + ".tmp", "wb") as f:
            f.write(corps)
        os.replace(chemin + ".tmp", chemin)
        return "lues", len(corps)

    debut = time.time()
    with cf.ThreadPoolExecutor(fils) as ex:
        for i, (etat, octets) in enumerate(ex.map(une, taches), 1):
            compte[etat] += 1
            compte["octets"] += octets
            if i % 2000 == 0:
                print(f"  {i}/{len(taches)}, {compte['octets'] / 1e6:.0f} Mo, {time.time() - debut:.0f} s", flush=True)
    resume = {"zooms": [ZOOM_MIN, zoom_max], "alti": [ALTI_MIN, ALTI_MAX],
              "ortho": {z: len(l) for z, l in ortho.items()}, "altitudes": len(alti), **compte,
              "zone": mapping(zone)}
    with open(os.path.join(site, "tuiles", "zone.json"), "w", encoding="utf-8") as f:
        json.dump(resume, f)
    print(f"{compte['lues']} lues, {compte['deja']} déjà là, {compte['absentes']} absentes à l'IGN, "
          f"{compte['octets'] / 1e6:.0f} Mo, {time.time() - debut:.0f} s")
    return resume


def main(argv):
    args = argv[1:]
    zoom_max = ZOOM_MAX
    if "--zoom-max" in args:
        i = args.index("--zoom-max")
        zoom_max = int(args[i + 1])
        del args[i:i + 2]
        if not ZOOM_MIN <= zoom_max <= 18:
            print("--zoom-max : de 9 à 18", file=sys.stderr)
            return 2
    if len(args) == 4 and args[0] == "zone" and args[1] == "--osm":
        zone, nom = zone_osm(args[2])
        c = zone.centroid
        with open(args[3], "w", encoding="utf-8") as f:
            json.dump({"type": "Feature", "properties": {"nom": nom}, "geometry": mapping(zone)}, f)
        km2 = zone.area * M_PAR_DEGRE ** 2 * math.cos(math.radians(c.y)) / 1e6
        print(f"{nom} : {km2:.0f} km², centre {c.y:.5f}, {c.x:.5f}, emprise {zone.bounds}")
        print(f"CENTRE={c.y:.5f},{c.x:.5f}")
        return 0
    if len(args) == 2 and args[0] == "compter":
        ortho, alti = inventaire(lire_zone(args[1]), zoom_max)
        for z, l in ortho.items():
            print(f"zoom {z} : {len(l)} tuiles")
        print(f"altitudes : {len(alti)} tuiles ; total {sum(map(len, ortho.values())) + len(alti)}")
        return 0
    if len(args) == 3 and args[0] == "lire":
        telecharger(lire_zone(args[1]), args[2], zoom_max)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
