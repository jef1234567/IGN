"""Couches publiques d'un camp (outils/couches_camp.py), sans réseau."""

import importlib.util
import json
import pathlib
import sys

from shapely.geometry import box

RACINE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE / "outils"))
_spec = importlib.util.spec_from_file_location("couches_camp", RACINE / "outils" / "couches_camp.py")
cc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cc)

ZONE = box(6.43, 43.69, 6.455, 43.708)


def f(geom, **props):
    return {"type": "Feature", "properties": props, "geometry": geom}


def ligne(*pts):
    return {"type": "LineString", "coordinates": [list(p) for p in pts]}


def point(x, y):
    return {"type": "Point", "coordinates": [x, y]}


# Un pont de 30 m sur le plateau, le tronçon de route qui le franchit (3,5 t),
# un gué, une citerne DFCI, une cascade (écartée), une piste DFCI, un chemin,
# une ZNIEFF qui déborde de la zone et une ZPS loin dehors.
DONNEES = {
    "BDTOPO_V3:troncon_de_route": [
        f(ligne((6.4400, 43.700), (6.4404, 43.700)), nature="Route à 1 chaussée", position_par_rapport_au_sol="1",
          restriction_de_poids_total="3.5", etat_de_l_objet="En service"),
        f(ligne((6.4450, 43.701), (6.4452, 43.701)), nature="Route empierrée",
          position_par_rapport_au_sol="Gué ou radier", etat_de_l_objet="En service"),
        f(ligne((6.435, 43.695), (6.445, 43.705)), nature="Route empierrée", piste_dfci="True",
          categorie_dfci="2ème catégorie", largeur_de_chaussee="4", position_par_rapport_au_sol="0",
          etat_de_l_objet="En service"),
        f(ligne((6.436, 43.696), (6.437, 43.697)), nature="Chemin", piste_dfci=None, position_par_rapport_au_sol="0",
          etat_de_l_objet="En service"),
    ],
    "BDTOPO_V3:construction_lineaire": [
        f(ligne((6.4400, 43.70001), (6.4404, 43.70001)), nature="Pont", etat_de_l_objet="En service"),
        f(ligne((6.44, 43.69), (6.45, 43.69)), nature="Mur de soutènement", etat_de_l_objet="En service"),
    ],
    "BDTOPO_V3:detail_hydrographique": [
        f(point(6.441, 43.702), nature="Citerne", nature_detaillee="DFCI"),
        f(point(6.442, 43.702), nature="Cascade"),
        f(point(6.443, 43.702), nature="Point d'eau", nature_detaillee="Puits", toponyme="Puits Fausset"),
    ],
    "BDTOPO_V3:reservoir": [
        f({"type": "Polygon", "coordinates": [[[6.44, 43.70], [6.4401, 43.70], [6.4401, 43.7001], [6.44, 43.70]]]},
          nature="Réservoir d'eau ou château d'eau au sol", hauteur="3.1"),
    ],
    "BDTOPO_V3:ligne_electrique": [
        f(ligne((6.40, 43.70), (6.50, 43.70)), voltage="225 kV", etat_de_l_objet="En service"),
    ],
    "BDTOPO_V3:construction_ponctuelle": [f(point(6.44, 43.70), nature="Transformateur"),
                                          f(point(6.44, 43.70), nature="Croix")],
    "patrinat_znieff1:znieff1": [
        f({"type": "Polygon", "coordinates": [[[6.40, 43.68], [6.45, 43.68], [6.45, 43.70], [6.40, 43.70], [6.40, 43.68]]]},
          nom_site="PLANS DE CANJUERS", id_mnhn="930012568", url_fiche="https://inpn.mnhn.fr/zone/znieff/930012568"),
    ],
    "patrinat_zps:zps": [
        f({"type": "Polygon", "coordinates": [[[7.0, 44.0], [7.1, 44.0], [7.1, 44.1], [7.0, 44.0]]]}, nom_site="Loin"),
    ],
    cc.PRSF: [f(point(6.44, 43.70), code_prsf="PRS 83 83269", desc_prsf="Champ de Tir TC12", coord_dfci="LD24D8.3")],
}


def lire(typename, autour):
    return DONNEES.get(typename, [])


def classes(fc):
    return [o["properties"]["classe"] for o in fc["features"]]


def test_pont_prend_le_tonnage_du_troncon_et_le_gue_est_garde():
    fc = cc.eau(cc.elargir(ZONE, cc.MARGE_M), lire)
    assert sorted(classes(fc)) == ["citerne", "gue", "point_eau", "pont", "reservoir"]
    pont = next(o for o in fc["features"] if o["properties"]["classe"] == "pont")
    assert pont["properties"]["texte"] == "Pont · 3,5 t" and pont["properties"]["tonnage"] == 3.5
    citerne = next(o for o in fc["features"] if o["properties"]["classe"] == "citerne")
    assert citerne["properties"]["texte"] == "Citerne DFCI"
    puits = next(o for o in fc["features"] if o["properties"]["classe"] == "point_eau")
    assert puits["properties"]["texte"] == "Puits (Puits Fausset)"


def test_piste_dfci_avant_sa_nature_et_points_de_secours():
    fc = cc.pistes(cc.elargir(ZONE, cc.MARGE_M), lire)
    assert sorted(classes(fc)) == ["chemin", "dfci", "empierree", "prsf", "route"]
    dfci = next(o for o in fc["features"] if o["properties"]["classe"] == "dfci")
    assert dfci["properties"]["dfci"] == "2ème catégorie" and dfci["properties"]["largeur"] == 4
    assert next(o for o in fc["features"] if o["properties"]["classe"] == "prsf")["properties"]["texte"] \
        == "Secours 83 83269 (Champ de Tir TC12)"


def test_protections_decoupees_sur_la_zone_et_nommees():
    autour = cc.elargir(ZONE, cc.MARGE_M)
    fc = cc.protections(autour, lire)
    assert classes(fc) == ["znieff1"]           # la ZPS lointaine est écartée
    p = fc["features"][0]["properties"]
    assert p["texte"] == "ZNIEFF 1 Plans de Canjuers" and p["fiche"].startswith("https://inpn.mnhn.fr/")
    o, s, e, n = autour.bounds
    g = fc["features"][0]["geometry"]
    assert g["type"] in ("LineString", "MultiLineString")
    lignes = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
    xs = [c[0] for l in lignes for c in l]
    assert min(xs) >= o - 1e-5                  # découpée : plus rien à 6,40
    # Seul le vrai bord est tracé (nord, sud et est de la ZNIEFF), pas la
    # coupure à l'ouest, le long de la marge.
    assert all(min(abs(c[1] - 43.70), abs(c[1] - 43.68), abs(c[0] - 6.45)) < 1e-4 for l in lignes for c in l)
    assert "INPN" in fc["source"]


def test_electricite_sans_osm_puis_avec():
    autour = cc.elargir(ZONE, cc.MARGE_M)
    fc = cc.electricite(autour, lire)
    assert sorted(classes(fc)) == ["ht", "poste"] and "OpenStreetMap" not in fc["source"]
    osm = [{"type": "way", "tags": {"power": "minor_line", "voltage": "20000"},
            "geometry": [{"lon": 6.44, "lat": 43.695}, {"lon": 6.45, "lat": 43.705}]},
           {"type": "way", "tags": {"power": "line"}, "geometry": [{"lon": 6.44, "lat": 43.69}, {"lon": 6.45, "lat": 43.69}]}]
    fc = cc.electricite(autour, lire, osm)
    assert sorted(classes(fc)) == ["distribution", "ht", "poste"]
    assert "OpenStreetMap" in fc["source"]


def test_lire_couches_ecrit_l_index(tmp_path):
    def osm_muet(autour):
        raise RuntimeError("Overpass indisponible")
    index = cc.lire_couches(ZONE, tmp_path, lire, osm_muet)
    assert set(index["couches"]) == {"protections", "electricite", "eau", "pistes"}
    relu = json.loads((tmp_path / "couches.json").read_text())
    assert relu["couches"]["eau"]["objets"] == 5
    assert json.loads((tmp_path / "pistes.geojson").read_text())["type"] == "FeatureCollection"
