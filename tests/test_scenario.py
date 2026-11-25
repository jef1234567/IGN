"""Conversion du tableur de scénario (outils/scenario.py) en scenario.json."""

import datetime as dt
import json
import importlib.util
import pathlib

import pytest

RACINE = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("scenario", RACINE / "outils" / "scenario.py")
scenario = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scenario)

ENTETE = ["Début", "Fin", "Type", "Lieu", "Libellé", "Couleur", "Taille (m)"]


def feuilles(evenements, reglages=None, points=None):
    reglages = reglages or [("Date", "24/11/2026"), ("Début", "06:00")]
    return {
        "Scénario": [("Clé", "Valeur")] + list(reglages),
        "Points": [("Nom", "Latitude", "Longitude")] + list(points or [("Église", 49.5454, 3.9665)]),
        "Événements": [ENTETE] + [list(e) for e in evenements],
    }


def test_fumigene_complet():
    s = scenario.convertir(feuilles([("06:10", "06:14", "fumigène", "Église", "Masque", "Rouge", 20)]))
    assert s["format"] == "scenario-cenzub" and s["version"] == 1
    assert s["date"] == "2026-11-24" and s["debut"] == 6 * 3600
    ev, = s["evenements"]
    assert ev["type"] == "fumigene" and ev["debut"] == 6 * 3600 + 600 and ev["fin"] == 6 * 3600 + 840
    assert (ev["lat"], ev["lon"]) == (49.5454, 3.9665)
    assert ev["params"] == {"couleur": "rouge", "taille_m": 20.0}
    # Sans fin saisie, la frise dure une heure au moins.
    assert s["fin"] == 7 * 3600


def test_fumigene_par_defaut_et_heures_excel():
    s = scenario.convertir(feuilles([(dt.time(6, 30), None, "fumigene", "49.5450, 3.9670", None, None, None)]))
    ev, = s["evenements"]
    assert ev["fin"] - ev["debut"] == scenario.DUREE_FUMIGENE_S
    assert ev["params"] == {"couleur": "blanc", "taille_m": scenario.TAILLE_FUMIGENE_M}


def test_nuit_passe_minuit():
    s = scenario.convertir(feuilles([("00:30", None, "jalon", None, "H", None, None)],
                                    reglages=[("Date", "2026-11-24"), ("Début", "22:00"), ("Fin", "02:00")]))
    assert s["evenements"][0]["debut"] == 86400 + 1800
    assert s["fin"] == 86400 + 7200


def test_colonne_inconnue_gardee_pour_les_types_a_venir():
    f = feuilles([])
    f["Événements"] = [ENTETE + ["Symbole (SIDC)"],
                       ["06:05", None, "unite", "Église", "Section", None, None, "SFGPUCI----D"]]
    ev, = scenario.convertir(f)["evenements"]
    assert ev["type"] == "unite" and ev["params"] == {"symbole_sidc": "SFGPUCI----D"}


def test_erreurs_toutes_listees():
    with pytest.raises(scenario.ErreurScenario) as e:
        scenario.convertir(feuilles([
            ("06:10", None, "fumée", "Église", None, None, None),
            ("25:00", None, "fumigene", "Église", None, None, None),
            ("06:10", None, "fumigene", "Mairie", None, None, None),
            ("06:10", None, "fumigene", "Église", None, "bleu", None),
            ("06:10", "06:00", "fumigene", "Église", None, None, None),
            ("06:10", None, "fumigene", "48.85, 2.29", None, None, None),
        ]))
    texte = str(e.value)
    for n in range(2, 8):
        assert f"ligne {n}" in texte
    assert "type 'fumee' inconnu" in texte and "heure hors bornes" in texte and "lieu inconnu" in texte
    assert "couleur 'bleu'" in texte and "fin avant le début" in texte and "plus de 5000 m" in texte


def test_reglages_manquants():
    with pytest.raises(scenario.ErreurScenario, match="date"):
        scenario.convertir(feuilles([], reglages=[("Début", "06:00")]))


def test_modele_se_convertit(tmp_path):
    pytest.importorskip("openpyxl")
    chemin = tmp_path / "modele.xlsx"
    scenario.ecrire_modele(chemin)
    s = scenario.convertir(scenario.lire_xlsx(chemin))
    assert [e["type"] for e in s["evenements"]] == ["jalon", "fumigene", "fumigene", "fumigene"]
    assert s["evenements"][-1]["params"]["vent_d_ou"] == 200


def test_modele_du_depot_a_jour(tmp_path):
    """cenzub/scenario-modele.xlsx est celui qu'écrit ecrire_modele."""
    pytest.importorskip("openpyxl")
    chemin = tmp_path / "modele.xlsx"
    scenario.ecrire_modele(chemin)
    neuf = scenario.lire_xlsx(chemin)
    assert scenario.lire_xlsx(RACINE / "cenzub" / "scenario-modele.xlsx") == neuf


def test_json_de_l_editeur(tmp_path):
    """Un scenario.json exporté par l'éditeur : unité et itinéraire relus tels quels."""
    s = scenario.convertir(feuilles([("06:10", None, "fumigene", "Église", None, None, None)]))
    s["evenements"].append({"id": "x1", "type": "unite", "debut": 21600, "fin": 22200, "libelle": "1re Cie",
                            "lat": 49.5454, "lon": 3.9665,
                            "params": {"camp": "ami", "sidc": "SFGPUCI----E---",
                                       "trajet": [{"t": 21600, "lat": 49.5454, "lon": 3.9665},
                                                  {"t": 22200, "lat": 49.546, "lon": 3.968}]}})
    chemin = tmp_path / "scenario.json"
    chemin.write_text(json.dumps(s), encoding="utf-8")
    assert scenario.verifier_json(str(chemin)) == s
    s["evenements"][-1]["params"]["trajet"][1]["lat"] = 48.85
    chemin.write_text(json.dumps(s), encoding="utf-8")
    with pytest.raises(scenario.ErreurScenario, match="point de 06:10"):
        scenario.verifier_json(str(chemin))


def test_phase_au_tableur_trace_refuse():
    s = scenario.convertir(feuilles([("06:00", "06:20", "phase", None, "Phase 1", None, None)]))
    assert s["evenements"][0] == {"id": "e2", "type": "phase", "debut": 21600, "fin": 22800, "libelle": "Phase 1"}
    with pytest.raises(scenario.ErreurScenario, match="éditeur"):
        scenario.convertir(feuilles([("06:00", None, "trace", "Église", "LD", None, None)]))


def test_exemple_publie_valide():
    """cenzub/scenario.json, l'exemple publié avec le site, passe la vérification."""
    s = scenario.verifier_json(str(RACINE / "cenzub" / "scenario.json"))
    assert {e["type"] for e in s["evenements"]} >= {"unite", "trace", "phase", "fumigene", "jalon"}
