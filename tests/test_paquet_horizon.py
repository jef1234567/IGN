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
