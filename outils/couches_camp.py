"""Couches publiques d'un camp, rangées à côté de la page (`&vaste=1`).

Quatre fichiers GeoJSON, un par bouton de la page (interface/couches-camp.js) :

  protections.geojson   Natura 2000 (ZPS, ZSC/SIC), ZNIEFF, parcs, réserves,
                        arrêtés de biotope : données de l'INPN (MNHN, OFB)
                        servies par la Géoplateforme (couches PROTECTEDAREAS.*)
  electricite.geojson   lignes électriques et postes de transformation (BD TOPO)
  eau.geojson           ponts, gués, points d'eau et réservoirs (BD TOPO)
  pistes.geojson        routes empierrées, chemins et sentiers, classés (BD TOPO)

Tout est lu sur le camp élargi de MARGE_M, simplifié à SIMPLIFIER_DEG.

  python outils/couches_camp.py inventaire zones/canjuers.geojson
  python outils/couches_camp.py lire zones/canjuers.geojson zones/canjuers-couches

`inventaire` compte, couche par couche, les valeurs des attributs utiles :
c'est sur lui que se fixent les natures gardées ci-dessous.
"""

import collections
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET

import requests
from shapely.geometry import mapping, shape
from shapely.prepared import prep

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paquet_horizon import ENTETES, elargir, lire_zone  # noqa: E402

URL_WFS = "https://data.geopf.fr/wfs/ows"
PAGE = 1000
MARGE_M = 2000
# 10 m : un chemin lu au zoom 17 (0,9 m par pixel) reste sur sa trace à l'œil.
SIMPLIFIER_DEG = 0.0001
LICENCE_IGN = "BD TOPO (IGN), Licence Ouverte 2.0"
LICENCE_INPN = "INPN (MNHN, OFB), via la Géoplateforme IGN, Licence Ouverte 2.0"

# Les couches BD TOPO lues, et les attributs gardés de chacune.
BDTOPO = {
    "ligne_electrique": ("nature", "voltage", "etat_de_l_objet"),
    "poste_de_transformation": ("nature", "toponyme", "etat_de_l_objet"),
    "construction_lineaire": ("nature", "nature_detaillee", "toponyme", "etat_de_l_objet"),
    "construction_ponctuelle": ("nature", "nature_detaillee", "toponyme", "hauteur", "etat_de_l_objet"),
    "detail_hydrographique": ("nature", "nature_detaillee", "toponyme", "etat_de_l_objet"),
    "reservoir": ("nature", "toponyme", "hauteur", "etat_de_l_objet"),
    "plan_d_eau": ("nature", "toponyme", "persistance", "etat_de_l_objet"),
    "parc_ou_reserve": ("nature", "nature_detaillee", "toponyme", "etat_de_l_objet"),
    "troncon_de_route": ("nature", "importance", "largeur_de_chaussee", "nombre_de_voies",
                         "acces_vehicule_leger", "position_par_rapport_au_sol", "restriction_de_poids_total",
                         "restriction_de_largeur", "nom_collaboratif_gauche", "etat_de_l_objet",
                         "itineraire_vert", "periode_de_fermeture", "piste_dfci", "categorie_dfci",
                         "gabarit_dfci", "tout_terrain_dfci", "nature_detaillee_dfci", "prive",
                         "ouvrage_d_art_limitant_dfci", "pente_maximale_dfci", "restriction_de_hauteur",
                         "restriction_de_poids_par_essieu", "nature_de_la_restriction", "urbain"),
}


def get(url, essais=6):
    for essai in range(essais):
        try:
            r = requests.get(url, headers=ENTETES, timeout=120)
            r.raise_for_status()
            return r
        except requests.RequestException:
            # Les refus de la Géoplateforme sont sporadiques (CLAUDE.md).
            if essai == essais - 1:
                raise
            time.sleep(2 * (essai + 1))


def wfs(typename, autour):
    """Tous les objets d'une couche WFS dans l'emprise de `autour`, page à page."""
    o, s, e, n = autour.bounds
    objets, debut = [], 0
    while True:
        url = (f"{URL_WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES={typename}"
               f"&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT={PAGE}&STARTINDEX={debut}"
               f"&BBOX={s},{o},{n},{e},urn:ogc:def:crs:EPSG::4326")
        page = get(url).json()["features"]
        objets += page
        if len(page) < PAGE:
            return objets
        debut += PAGE


# Les couches d'espaces protégés de l'INPN, dans les noms du WFS : « parc »
# seul prendrait les parcelles du cadastre (plus de 20 min de lecture le
# 26 novembre 2026).
RE_PROTEGE = re.compile(r"PROTECTEDAREAS|PROTECTEDSITES|natura|znieff|\bzps\b|\bzsc\b|\bsic\b|parc_?nat|parcs?\s+nat|"
                        r"r[ée]serves?_?nat|biotope|\bapb\b|\brnn\b|\brnr\b|ramsar", re.I)


def couches_protegees():
    """Les noms des couches PROTECTEDAREAS.* du WFS de la Géoplateforme."""
    xml = get(f"{URL_WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities").text
    racine = ET.fromstring(xml)
    noms = []
    for ft in racine.iter("{http://www.opengis.net/wfs/2.0}FeatureType"):
        nom = ft.findtext("{http://www.opengis.net/wfs/2.0}Name") or ""
        titre = ft.findtext("{http://www.opengis.net/wfs/2.0}Title") or ""
        if RE_PROTEGE.search(nom + " " + titre):
            noms.append((nom, titre))
    return noms


def inventaire(zone):
    autour = elargir(zone, MARGE_M)
    protegees = couches_protegees()
    print("Couches d'espaces protégés :", *(f"  {n} ({t})" for n, t in protegees), sep="\n")
    sys.stdout.flush()
    for nom, titre in protegees:
        try:
            objets = wfs(nom, autour)
        except requests.RequestException as e:
            print(f"\n== {nom} ({titre}) : illisible ({e})")
            continue
        print(f"\n== {nom} ({titre}) : {len(objets)}")
        if not objets:
            continue
        if objets:
            print("   attributs :", sorted(objets[0]["properties"]))
            for f in objets[:6]:
                print("   ", {k: v for k, v in f["properties"].items() if isinstance(v, (str, int, float)) and len(str(v)) < 80})
    for couche, attributs in BDTOPO.items():
        objets = wfs(f"BDTOPO_V3:{couche}", autour)
        print(f"\n== {couche} : {len(objets)}")
        if objets:
            print("   attributs :", sorted(objets[0]["properties"]))
        for a in attributs:
            c = collections.Counter(str(f["properties"].get(a)) for f in objets)
            if len(c) <= 40:
                print(f"   {a} : {dict(c.most_common())}")
            else:
                print(f"   {a} : {len(c)} valeurs, {c.most_common(10)}")


# --- Lecture des couches ----------------------------------------------------------

# Les espaces protégés de PatriNat (INPN) servis par la Géoplateforme, et leur
# classe dans la page. Lus le 26 novembre 2026 autour de Canjuers : 3 ZPS,
# 8 SIC, 14 ZNIEFF 1, 20 ZNIEFF 2, 2 PNR, 1 RNN, 2 APB. Plus complets que
# parc_ou_reserve de la BD TOPO (20 objets, sans les ZNIEFF), et avec le lien
# de leur fiche.
PROTECTIONS = {
    "patrinat_zps:zps": ("zps", "ZPS"),
    "patrinat_sic:sic": ("zsc", "ZSC"),
    "patrinat_znieff1:znieff1": ("znieff1", "ZNIEFF 1"),
    "patrinat_znieff2:znieff2": ("znieff2", "ZNIEFF 2"),
    "patrinat_pn:parc_national": ("pn", "Parc national"),
    "patrinat_pnr:pnr": ("pnr", "PNR"),
    "patrinat_rnn:rnn": ("reserve", "Réserve naturelle"),
    "patrinat_rnr:rnr": ("reserve", "Réserve naturelle"),
    "patrinat_apb:apb": ("apb", "Arrêté de biotope"),
}
# Points de rencontre des secours en forêt (ONF, même service) : où guider les
# secours sur un camp sans adresse. 41 autour de Canjuers.
PRSF = "PROTECTEDAREAS.PRSF:prsf"

# Points d'eau de detail_hydrographique (289 autour de Canjuers : 120 points
# d'eau, 79 citernes dont 35 DFCI, 34 fontaines, 22 lavoirs, 22 sources) ; les
# cascades et l'embouchure ne servent pas à s'approvisionner.
EAU_PONCTUELLE = {
    "Citerne": "citerne", "Point d'eau": "point_eau",
    "Source": "source", "Source captée": "source", "Résurgence": "source",
    "Fontaine": "source", "Lavoir": "source",
}
# Pistes : nature du tronçon BD TOPO → classe. Une piste DFCI (1 474 tronçons)
# passe avant sa nature : c'est elle que les pompiers entretiennent.
NATURE_PISTE = {
    "Route à 1 chaussée": "route", "Route à 2 chaussées": "route", "Rond-point": "route",
    "Bretelle": "route", "Type autoroutier": "route",
    "Route empierrée": "empierree", "Chemin": "chemin", "Sentier": "sentier", "Escalier": "sentier",
}
# Un pont de construction_lineaire prend le tonnage du tronçon de route posé
# dessus (position 1) à moins de 15 m : 221 tronçons sur ponts, 70 limités.
PONT_TRONCON_M = 15


def _nombre(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _fr(v):
    return f"{v:g}".replace(".", ",")


def _arrondir(g):
    """La géométrie à 5 décimales (1 m), sans sommets répétés."""
    def anneau(coords):
        sortie = []
        for c in coords:
            p = [round(c[0], 5), round(c[1], 5)]
            if not sortie or sortie[-1] != p:
                sortie.append(p)
        return sortie
    t, c = g["type"], g["coordinates"]
    if t == "Point":
        return {"type": t, "coordinates": [round(c[0], 5), round(c[1], 5)]}
    if t == "LineString":
        return {"type": t, "coordinates": anneau(c)}
    if t in ("MultiLineString", "Polygon"):
        return {"type": t, "coordinates": [anneau(a) for a in c]}
    if t == "MultiPolygon":
        return {"type": t, "coordinates": [[anneau(a) for a in p] for p in c]}
    raise ValueError(t)


def _decouper(geometrie, autour, simplifier=SIMPLIFIER_DEG):
    """La géométrie gardée dans `autour`, simplifiée ; None si rien n'y reste."""
    g = shape(geometrie)
    if not g.is_valid:
        g = g.buffer(0)
    g = g.intersection(autour)
    if g.is_empty:
        return None
    if g.geom_type == "GeometryCollection":
        parties = [p for p in g.geoms if p.geom_type in ("LineString", "MultiLineString", "Polygon", "MultiPolygon")]
        if not parties:
            return None
        g = parties[0] if len(parties) == 1 else max(parties, key=lambda p: p.length + p.area)
    if simplifier and g.geom_type != "Point":
        g = g.simplify(simplifier, preserve_topology=True)
    return _arrondir(mapping(g))


def _objet(geometrie, classe, **props):
    return {"type": "Feature", "properties": {"classe": classe, **{k: v for k, v in props.items() if v not in (None, "")}},
            "geometry": geometrie}


# Les mots qui restent en minuscules dans un nom de lieu remis en casse.
PETITS_MOTS = {"de", "du", "des", "la", "le", "les", "et", "en", "sur", "sous", "aux", "au", "d", "l"}


def _casse_titre(nom):
    """« GORGES DE L'ARTUBY, SAINT-ROMAIN » → « Gorges de l'Artuby, Saint-Romain »."""
    def mot(m, premier):
        bas = m.group(0).lower()
        return bas if (bas in PETITS_MOTS and not premier) else bas[:1].upper() + bas[1:]
    morceaux = re.split(r"([\s,\-'’()]+)", nom)
    return "".join(re.sub(r"\w+", lambda m: mot(m, i == 0), p) if i % 2 == 0 else p
                   for i, p in enumerate(morceaux))


def _point(lon, lat):
    return {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}


def protections(autour, lire=wfs):
    """Les espaces protégés, contours découpés sur `autour`, nom au point intérieur."""
    sortie = []
    for typename, (classe, sigle) in PROTECTIONS.items():
        for f in lire(typename, autour):
            p = f["properties"]
            g = _decouper(f["geometry"], autour, simplifier=0.0002)
            if g is None:
                continue
            interieur = shape(g).representative_point()
            nom = (p.get("nom_site") or "").strip()
            # Les ZNIEFF sont nommées en capitales : « PLANS DE CANJUERS ».
            if nom.isupper():
                nom = _casse_titre(nom)
            sortie.append(_objet(g, classe, texte=f"{sigle} {nom}".strip(), nom=nom, code=p.get("id_mnhn"),
                                 fiche=p.get("url_fiche"), etiquette=[round(interieur.x, 5), round(interieur.y, 5)]))
    return {"type": "FeatureCollection", "source": LICENCE_INPN, "features": sortie}


def electricite(autour, lire=wfs, osm=None):
    """Lignes électriques BD TOPO, transformateurs, et les lignes de distribution
    d'OpenStreetMap quand `osm` les donne (la BD TOPO n'a que la haute tension :
    une ligne de 225 kV autour de Canjuers)."""
    dedans = prep(autour)
    sortie = []
    for f in lire("BDTOPO_V3:ligne_electrique", autour):
        p = f["properties"]
        if p.get("etat_de_l_objet") not in (None, "En service"):
            continue
        g = _decouper(f["geometry"], autour)
        if g is None:
            continue
        mi = shape(g).interpolate(0.5, normalized=True)
        sortie.append(_objet(g, "ht", texte=f"Ligne {p.get('voltage') or 'HT'}", tension=p.get("voltage"),
                             gestionnaire=p.get("gestionnaire"), etiquette=[round(mi.x, 5), round(mi.y, 5)]))
    for f in lire("BDTOPO_V3:poste_de_transformation", autour):
        c = shape(f["geometry"]).representative_point()
        if dedans.contains(c):
            sortie.append(_objet(_point(c.x, c.y), "poste", texte="Poste électrique", nom=f["properties"].get("toponyme")))
    for f in lire("BDTOPO_V3:construction_ponctuelle", autour):
        if f["properties"].get("nature") != "Transformateur" or f["geometry"]["type"] != "Point":
            continue
        x, y = f["geometry"]["coordinates"][:2]
        if dedans.contains(shape(f["geometry"])):
            sortie.append(_objet(_point(x, y), "poste", texte="Transformateur"))
    source = LICENCE_IGN
    if osm:
        for el in osm:
            if el.get("type") != "way" or len(el.get("geometry", [])) < 2:
                continue
            t = el.get("tags", {})
            if t.get("power") not in ("minor_line", "line", "cable"):
                continue
            ht = t.get("power") == "line"
            if ht and any(o["properties"]["classe"] == "ht" for o in sortie):
                # La haute tension vient de la BD TOPO quand elle l'a ; OSM ne la
                # redouble pas.
                continue
            g = _decouper({"type": "LineString", "coordinates": [(q["lon"], q["lat"]) for q in el["geometry"]]}, autour)
            if g is not None:
                tension = t.get("voltage")
                tension = f"{int(tension) // 1000} kV" if (tension or "").isdigit() else None
                mi = shape(g).interpolate(0.5, normalized=True)
                sortie.append(_objet(g, "ht" if ht else "distribution", tension=tension, osm=True,
                                     texte=f"Ligne {tension or 'HT'}" if ht else None,
                                     etiquette=[round(mi.x, 5), round(mi.y, 5)] if ht else None))
        source += " ; lignes de distribution © contributeurs OpenStreetMap, ODbL"
    return {"type": "FeatureCollection", "source": source, "features": sortie}


def electricite_osm(autour):
    """Les lignes électriques d'OpenStreetMap autour de `autour` (Overpass)."""
    from paquet_horizon import overpass
    o, s, e, n = autour.bounds
    requete = f'[out:json][timeout:120];way["power"~"^(line|minor_line|cable)$"]({s:.5f},{o:.5f},{n:.5f},{e:.5f});out geom;'
    return overpass(requete, lambda el: el, tours=2, delai=150)


def eau(autour, lire=wfs):
    """Ponts (avec leur limite de tonnage), gués, points d'eau et réservoirs."""
    dedans = prep(autour)
    sortie = []
    troncons = lire("BDTOPO_V3:troncon_de_route", autour)
    # Les tronçons sur pont qui portent une limite : leur tonnage et leur largeur.
    limites = []
    for f in troncons:
        p = f["properties"]
        if str(p.get("position_par_rapport_au_sol")) == "1":
            limites.append((shape(f["geometry"]), _nombre(p.get("restriction_de_poids_total")),
                            _nombre(p.get("restriction_de_largeur")), _nombre(p.get("restriction_de_hauteur"))))
        elif p.get("position_par_rapport_au_sol") == "Gué ou radier":
            g = _decouper(f["geometry"], autour, simplifier=0)
            if g is not None:
                mi = shape(g).interpolate(0.5, normalized=True)
                tonnage = _nombre(p.get("restriction_de_poids_total"))
                sortie.append(_objet(g, "gue", texte="Gué" + (f" {_fr(tonnage)} t" if tonnage else ""),
                                     etiquette=[round(mi.x, 5), round(mi.y, 5)]))
    k = PONT_TRONCON_M / 111320
    for f in lire("BDTOPO_V3:construction_lineaire", autour):
        p = f["properties"]
        if p.get("nature") != "Pont" or p.get("etat_de_l_objet") not in (None, "En service"):
            continue
        g = _decouper(f["geometry"], autour, simplifier=0)
        if g is None:
            continue
        ligne = shape(g)
        proches = [l for l in limites if l[0].distance(ligne) < k]
        tonnage = min((l[1] for l in proches if l[1]), default=None)
        largeur = min((l[2] for l in proches if l[2]), default=None)
        hauteur = min((l[3] for l in proches if l[3]), default=None)
        mots = [p.get("nature_detaillee") if p.get("nature_detaillee") in ("Passerelle",) else "Pont"]
        if tonnage:
            mots.append(f"{_fr(tonnage)} t")
        if largeur:
            mots.append(f"{_fr(largeur)} m de large")
        mi = ligne.interpolate(0.5, normalized=True)
        sortie.append(_objet(g, "pont", texte=" · ".join(mots), nom=p.get("toponyme"), tonnage=tonnage,
                             largeur=largeur, hauteur=hauteur, etiquette=[round(mi.x, 5), round(mi.y, 5)]))
    for f in lire("BDTOPO_V3:detail_hydrographique", autour):
        p = f["properties"]
        classe = EAU_PONCTUELLE.get(p.get("nature"))
        if not classe or f["geometry"]["type"] != "Point" or not dedans.contains(shape(f["geometry"])):
            continue
        x, y = f["geometry"]["coordinates"][:2]
        detail = p.get("nature_detaillee")
        texte = {"citerne": "Citerne DFCI" if detail == "DFCI" else "Citerne",
                 "point_eau": "Puits" if detail == "Puits" else "Point d'eau"}.get(classe, p.get("nature"))
        if p.get("toponyme"):
            texte = p["toponyme"] if classe == "source" else f"{texte} ({p['toponyme']})"
        sortie.append(_objet(_point(x, y), classe, texte=texte, nature=p.get("nature"), detail=detail))
    for f in lire("BDTOPO_V3:reservoir", autour):
        p = f["properties"]
        c = shape(f["geometry"]).representative_point()
        if not dedans.contains(c):
            continue
        h = _nombre(p.get("hauteur"))
        sortie.append(_objet(_point(c.x, c.y), "reservoir",
                             texte="Réservoir d'eau" + (f" {_fr(h)} m" if h else ""), hauteur=h))
    return {"type": "FeatureCollection", "source": LICENCE_IGN, "features": sortie}


def pistes(autour, lire=wfs):
    """Routes, pistes, chemins et sentiers, classés ; points de rencontre des secours."""
    sortie = []
    for f in lire("BDTOPO_V3:troncon_de_route", autour):
        p = f["properties"]
        classe = NATURE_PISTE.get(p.get("nature"))
        if not classe or p.get("etat_de_l_objet") not in (None, "En service"):
            continue
        if str(p.get("piste_dfci")) == "True":
            classe = "dfci"
        g = _decouper(f["geometry"], autour)
        if g is None:
            continue
        sortie.append(_objet(g, classe, nature=p.get("nature"), dfci=p.get("categorie_dfci"),
                             largeur=_nombre(p.get("largeur_de_chaussee")), acces=p.get("acces_vehicule_leger"),
                             tonnage=_nombre(p.get("restriction_de_poids_total"))))
    dedans = prep(autour)
    for f in lire(PRSF, autour):
        p = f["properties"]
        if f["geometry"]["type"] != "Point" or not dedans.contains(shape(f["geometry"])):
            continue
        x, y = f["geometry"]["coordinates"][:2]
        texte = "Secours " + (p.get("code_prsf") or "").replace("PRS ", "")
        if (p.get("desc_prsf") or "").strip():
            texte += f" ({p['desc_prsf'].strip()})"
        sortie.append(_objet(_point(x, y), "prsf", texte=texte, dfci=p.get("coord_dfci")))
    return {"type": "FeatureCollection", "source": LICENCE_IGN + " ; points de rencontre des secours en forêt : ONF, via la Géoplateforme",
            "features": sortie}


def lire_couches(zone, dossier, lire=wfs, osm=electricite_osm):
    """Les quatre couches et leur index (couches.json) dans `dossier`."""
    autour = elargir(zone, MARGE_M)
    try:
        lignes_osm = osm(autour) if osm else None
    except RuntimeError as e:
        # Overpass souvent muet (CLAUDE.md) : la BD TOPO suffit pour la haute tension.
        print(f"Lignes OSM non lues : {e}", file=sys.stderr)
        lignes_osm = None
    couches = {
        "protections": protections(autour, lire),
        "electricite": electricite(autour, lire, lignes_osm),
        "eau": eau(autour, lire),
        "pistes": pistes(autour, lire),
    }
    os.makedirs(dossier, exist_ok=True)
    index = {"date": time.strftime("%Y-%m-%d"), "marge_m": MARGE_M, "couches": {}}
    for nom, fc in couches.items():
        with open(os.path.join(dossier, f"{nom}.geojson"), "w", encoding="utf-8") as f:
            json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
        compte = collections.Counter(o["properties"]["classe"] for o in fc["features"])
        index["couches"][nom] = {"objets": len(fc["features"]), "classes": dict(compte), "source": fc["source"]}
        print(f"{nom} : {len(fc['features'])} objets {dict(compte)}, "
              f"{os.path.getsize(os.path.join(dossier, f'{nom}.geojson')) / 1e6:.2f} Mo")
    with open(os.path.join(dossier, "couches.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    return index


def main(argv):
    if len(argv) >= 3 and argv[1] == "inventaire":
        inventaire(lire_zone(argv[2]))
        return 0
    if len(argv) >= 4 and argv[1] == "lire":
        lire_couches(lire_zone(argv[2]), argv[3])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
