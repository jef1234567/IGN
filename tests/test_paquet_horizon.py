"""Tuiles de l'horizon rangées pour la version hors réseau (outils/paquet_horizon.py)."""

import importlib.util
import json
import math
import pathlib

import pytest
from shapely.geometry import box

RACINE = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("paquet_horizon", RACINE / "outils" / "paquet_horizon.py")
ph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ph)

# Un carré de 2 km environ sur le plateau de Canjuers.
PETITE = box(6.43, 43.69, 6.455, 43.708)


def test_tuile_pm_et_ses_bornes():
    for z in (9, 14, 18):
        x, y = ph.tuile_pm(6.44, 43.70, z)
        o, s, e, n = ph.bornes_pm(x, y, z)
        assert o <= 6.44 < e and s < 43.70 <= n


def test_inventaire_couvre_la_zone_a_chaque_zoom():
    ortho, alti = ph.inventaire(PETITE)
    assert sorted(ortho) == list(range(9, 18))
    for z, liste in ortho.items():
        for lon, lat in [(6.43, 43.69), (6.455, 43.708), (6.442, 43.70)]:
            assert ph.tuile_pm(lon, lat, z) in liste
    # Au zoom 17 (tuiles de 220 m), la zone de 2 × 2 km élargie de 4 largeurs
    # de tuile fait ~3,8 km de côté : de l'ordre de 18 × 18 tuiles.
    assert 250 <= len(ortho[17]) <= 400
    assert {n for n, _, _ in alti} == set(range(6, 13))


def test_zoom_18_sur_demande():
    ortho, alti = ph.inventaire(PETITE, zoom_max=18)
    assert max(ortho) == 18 and len(ortho[18]) > 2 * len(ortho[17])
    assert max(n for n, _, _ in alti) == 13


def test_altitudes_comme_horizon_js():
    """Niveau z − 5 borné à [6, 14], la tuile et une maille de marge (altitudesTuile)."""
    x, y = ph.tuile_pm(6.44, 43.70, 17)
    lues = ph.tuiles_alti_pour(17, x, y)
    assert {n for n, _, _ in lues} == {12}
    o, s, e, n = ph.bornes_pm(x, y, 17)
    p = 180 / 2 ** 12 / 256
    for lon, lat in [(o, n), (e, s)]:
        assert (12, int((90 - lat) / p) >> 8, int((lon + 180) / p) >> 8) in lues
    assert {n for n, _, _ in ph.tuiles_alti_pour(9, *ph.tuile_pm(6.44, 43.70, 9), )} == {6}


def test_plus_grand_terrain_d_une_relation():
    def chemin(points):
        return [{"lon": a, "lat": b} for a, b in points]
    elements = [
        {"type": "way", "tags": {"name": "Petit"},
         "geometry": chemin([(0, 0), (0.1, 0), (0.1, 0.1), (0, 0)])},
        # Un anneau en deux chemins, comme une relation multipolygone.
        {"type": "relation", "tags": {"name": "Camp"}, "members": [
            {"role": "outer", "geometry": chemin([(1, 1), (2, 1), (2, 2)])},
            {"role": "outer", "geometry": chemin([(2, 2), (1, 2), (1, 1)])},
            {"role": "inner", "geometry": chemin([(1.2, 1.2), (1.3, 1.2), (1.3, 1.3), (1.2, 1.2)])}]},
    ]
    zone, nom = ph.plus_grand(elements)
    assert nom == "Camp" and zone.area == pytest.approx(1)
    with pytest.raises(ValueError):
        ph.plus_grand([])


def test_lire_zone(tmp_path):
    assert ph.lire_zone("6,43,7,44").bounds == (6, 43, 7, 44)
    f = tmp_path / "z.geojson"
    f.write_text(json.dumps({"type": "Feature", "geometry": {"type": "Polygon",
                             "coordinates": [[[6, 43], [7, 43], [7, 44], [6, 43]]]}}))
    assert ph.lire_zone(str(f)).bounds == (6, 43, 7, 44)


def test_telecharger_range_les_tuiles(tmp_path, monkeypatch):
    urls = []

    def lire(session, url, signature, essais=6):
        urls.append(url)
        if "TILEMATRIX=9&" in url and "ORTHO" in url:
            return None                     # absente à l'IGN : ni fichier ni échec
        return b"\xff\xd8jpeg" if signature else bytes(256 * 256 * 4)
    monkeypatch.setattr(ph, "lire", lire)
    zone = box(6.44, 43.70, 6.445, 43.703)
    resume = ph.telecharger(zone, str(tmp_path), zoom_max=12, fils=2)
    x, y = ph.tuile_pm(6.442, 43.701, 12)
    assert (tmp_path / "tuiles" / "ortho" / "12" / str(x) / f"{y}.jpg").read_bytes() == b"\xff\xd8jpeg"
    assert len(list((tmp_path / "tuiles" / "alti").rglob("*.bil"))) == resume["altitudes"]
    assert resume["absentes"] == resume["ortho"][9]
    assert json.loads((tmp_path / "tuiles" / "zone.json").read_text())["zooms"] == [9, 12]
    # Une seconde fois, rien n'est relu.
    n = len(urls)
    resume = ph.telecharger(zone, str(tmp_path), zoom_max=12, fils=2)
    assert resume["lues"] == 0 and len(urls) == n + resume["ortho"][9]


def test_altitudes_tronquees_refusees(tmp_path, monkeypatch):
    monkeypatch.setattr(ph, "lire", lambda s, url, sig, essais=6: b"\xff\xd8" if sig else b"court")
    with pytest.raises(RuntimeError):
        ph.telecharger(box(6.44, 43.70, 6.441, 43.701), str(tmp_path), zoom_max=9, fils=1)


def test_overpass_passe_au_miroir_suivant(monkeypatch):
    appels = []

    class Reponse:
        def __init__(self, ok):
            self.ok = ok

        def raise_for_status(self):
            if not self.ok:
                raise ph.requests.HTTPError("502")

        def json(self):
            return {"elements": [{"type": "way", "tags": {"name": "Camp"}, "geometry": [
                {"lon": a, "lat": b} for a, b in [(0, 0), (1, 0), (1, 1), (0, 0)]]}]}

    def post(url, **kw):
        appels.append(url)
        return Reponse(len(appels) > 1)
    monkeypatch.setattr(ph.requests, "post", post)
    zone, nom = ph.zone_osm("Camp", urls=("a", "b"))
    assert nom == "Camp" and appels == ["a", "b"]


def test_overpass_vide_demande_au_miroir_suivant(monkeypatch):
    class Vide:
        def raise_for_status(self):
            pass

        def json(self):
            return {"elements": []}
    monkeypatch.setattr(ph.requests, "post", lambda url, **kw: Vide())
    monkeypatch.setattr(ph.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="aucun terrain"):
        ph.zone_osm("Camp", urls=("a", "b"), tours=2)


def test_reperes_gardes_autour_de_la_zone():
    autour = box(6.0, 43.0, 6.2, 43.2)
    elements = [
        {"type": "node", "lon": 6.1, "lat": 43.1, "tags": {"place": "village", "name": "Comps"}},
        {"type": "node", "lon": 7.0, "lat": 43.1, "tags": {"place": "village", "name": "Loin"}},
        {"type": "node", "lon": 6.05, "lat": 43.05, "tags": {"natural": "peak", "name": "Le Mont", "ele": "1100"}},
        {"type": "way", "tags": {"highway": "secondary", "ref": "D 955"},
         "geometry": [{"lon": 5.9, "lat": 43.1}, {"lon": 6.1, "lat": 43.1}, {"lon": 6.3, "lat": 43.1}]},
    ]
    fc = ph.reperes_depuis(elements, autour)
    proprietes = [f["properties"] for f in fc["features"]]
    assert {"type": "village", "nom": "Comps"} in proprietes
    assert {"type": "sommet", "nom": "Le Mont", "ele": "1100"} in proprietes
    assert all(p.get("nom") != "Loin" for p in proprietes)
    route = next(f for f in fc["features"] if f["properties"]["type"] == "route")
    assert route["properties"]["ref"] == "D955"
    xs = [x for x, _ in route["geometry"]["coordinates"]]
    assert min(xs) >= 6.0 - 1e-9 and max(xs) <= 6.2 + 1e-9      # coupée au bord


def test_reperes_sans_lieu_demande_au_miroir_suivant(monkeypatch):
    class Routes:
        def raise_for_status(self):
            pass

        def json(self):
            return {"elements": [{"type": "way", "tags": {"ref": "D1"},
                                  "geometry": [{"lon": 6.1, "lat": 43.1}, {"lon": 6.11, "lat": 43.1}]}]}
    monkeypatch.setattr(ph.requests, "post", lambda url, **kw: Routes())
    monkeypatch.setattr(ph.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="aucun lieu"):
        ph.reperes_osm(box(6.0, 43.0, 6.2, 43.2), urls=("a",), tours=1)


def test_reperes_bdtopo_au_format_osm():
    autour = box(6.0, 43.0, 6.2, 43.2)
    couches = {
        "zone_d_habitation": [
            {"properties": {"toponyme": "Comps-sur-Artuby", "importance": "3", "nature": "Lieu-dit habité"},
             "geometry": {"type": "Polygon", "coordinates": [[[6.1, 43.1], [6.11, 43.1], [6.11, 43.11], [6.1, 43.1]]]}},
            {"properties": {"toponyme": "Vieux", "importance": "4", "nature": "Ruines"},
             "geometry": {"type": "Polygon", "coordinates": [[[6.1, 43.1], [6.11, 43.1], [6.11, 43.11], [6.1, 43.1]]]}}],
        "lieu_dit_non_habite": [{"properties": {"toponyme": "le Planet"},
                                 "geometry": {"type": "Point", "coordinates": [6.05, 43.05]}}],
        "detail_orographique": [{"properties": {"toponyme": "Fayet", "nature": "Sommet"},
                                 "geometry": {"type": "Point", "coordinates": [6.06, 43.06]}}],
        "route_numerotee_ou_nommee": [
            {"properties": {"type_de_route": "Départementale", "numero": "D955"},
             "geometry": {"type": "MultiLineString", "coordinates": [[[5.9, 43.1], [6.3, 43.1]]]}},
            {"properties": {"type_de_route": "Autoroute", "numero": "A8"},
             "geometry": {"type": "LineString", "coordinates": [[6.0, 43.15], [6.2, 43.15]]}}],
    }
    zone = box(6.05, 43.05, 6.15, 43.15)
    fc = ph.reperes_bdtopo(zone, lire=lambda couche, autour: couches[couche])
    props = [f["properties"] for f in fc["features"]]
    assert {"type": "hamlet", "nom": "Comps-sur-Artuby"} in props
    assert {"type": "locality", "nom": "le Planet"} in props
    assert {"type": "sommet", "nom": "Fayet"} in props
    assert all(p.get("nom") != "Vieux" for p in props)                      # ruines laissées
    assert [p["ref"] for p in props if p["type"] == "route"] == ["D955"]     # pas l'autoroute


def test_batiments_bdtopo():
    carre = [[6.1, 43.1], [6.1001, 43.1], [6.1001, 43.1001], [6.1, 43.1001], [6.1, 43.1]]
    couches = {"batiment": [
        {"properties": {"hauteur": 7.25}, "geometry": {"type": "Polygon", "coordinates": [carre]}},
        {"properties": {"hauteur": None, "nombre_d_etages": 2},
         "geometry": {"type": "MultiPolygon", "coordinates": [[carre]]}},
        {"properties": {}, "geometry": {"type": "Polygon", "coordinates": [carre]}},
        {"properties": {"hauteur": 9}, "geometry": {"type": "Polygon", "coordinates": [
            [[7.0, 43.1], [7.001, 43.1], [7.001, 43.101], [7.0, 43.1]]]}},          # trop loin
    ]}
    bati = ph.batiments_bdtopo(box(6.05, 43.05, 6.15, 43.15), lire=lambda couche, autour: couches[couche])
    assert [b[0] for b in bati] == [7.2, 6.0, 3.0]
    assert bati[0][1:] == [6.1, 43.1, 6.1001, 43.1, 6.1001, 43.1001, 6.1, 43.1001]
