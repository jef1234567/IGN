"""Tableur de scénario → scenario.json, lu par le calque scénario de la page.

Le tableur (.xlsx) a trois feuilles :

  Scénario     clé / valeur : Titre, Date (JJ/MM/AAAA), Début, Fin (HH:MM),
               Vent (d'où, °), Vent (m/s)
  Points       Nom, Latitude, Longitude : des lieux nommés, réutilisés dans
               la colonne Lieu des événements
  Événements   Début, Fin, Type, Lieu, Libellé, puis les paramètres du type
               (Couleur, Taille (m), Vent (d'où, °), Vent (m/s) pour un
               fumigène) ; toute colonne de plus passe telle quelle dans
               `params`, ce qui laisse la place aux types à venir (symbole
               OTAN, modèle 3D, trajet…) sans changer le format.

Les heures sont des secondes depuis 00:00 du jour du scénario ; une heure
plus tôt que le début est celle du lendemain (exercice de nuit).

  pip install openpyxl                                  (hors requirements)
  python outils/scenario.py scenario.xlsx scenario.json
  python outils/scenario.py --modele cenzub/scenario-modele.xlsx
  python outils/scenario.py scenario.json site/scenario.json   (exporté par
                                                l'éditeur : vérifié, recopié)
  python outils/scenario.py scenario.xlsx scenario.json --centre 43.70,6.43 --rayon 25000

--centre et --rayon (m) remplacent la scène CENZUB : un camp survolé hors
réseau, dont l'horizon couvre des dizaines de kilomètres (paquet_horizon.py).

Sort en erreur, ligne par ligne, sur tout ce qui ne se lit pas : un
scénario faux ne doit pas arriver sur le site.
"""

import datetime as dt
import math
import json
import re
import sys
import unicodedata

FORMAT = "scenario-cenzub"
VERSION = 1

# Types affichés par la page, et types réservés au format : ceux-ci passent
# déjà sur la frise, leur rendu viendra (plan validé du calque scénario).
TYPES_AFFICHES = {"fumigene", "jalon", "unite", "phase", "trace"}
TYPES_RESERVES = {"explosion", "incendie", "nuit"}
TYPES = TYPES_AFFICHES | TYPES_RESERVES

COULEURS = {"blanc", "rouge", "vert", "jaune", "violet", "orange", "noir"}
# Un pot fumigène d'exercice fume de l'ordre de 1 à 2 min ; sans fin saisie,
# le fumigène dure 2 min.
DUREE_FUMIGENE_S = 120
TAILLE_FUMIGENE_M = 15

# Emprise de la scène CENZUB (zone de 1 700 m autour de 49.5454, 3.9665),
# élargie à 5 km : un lieu au-delà est une faute de saisie. --centre et
# --rayon les remplacent.
CENTRE = (49.5454, 3.9665)
RAYON_MAX_M = 5000


class ErreurScenario(ValueError):
    pass


def cle(texte):
    """« Taille (m) » → « taille_m » : sans accents ni ponctuation."""
    t = unicodedata.normalize("NFKD", str(texte)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", t.lower()).strip("_")


def vide(v):
    return v is None or (isinstance(v, str) and not v.strip())


def lire_heure(v):
    """Secondes depuis 00:00 : « 06:30 », « 6h30 », « 06:30:15 », une heure
    Excel (time, datetime, ou fraction de jour)."""
    if isinstance(v, dt.datetime):
        v = v.time()
    if isinstance(v, dt.time):
        return v.hour * 3600 + v.minute * 60 + v.second
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v < 1:
        return round(v * 86400)
    m = re.fullmatch(r"\s*(\d{1,2})\s*[:hH]\s*(\d{2})?(?:\s*:\s*(\d{2}))?\s*", str(v))
    if not m:
        raise ErreurScenario(f"heure illisible : {v!r} (attendu HH:MM)")
    h, mn, s = int(m[1]), int(m[2] or 0), int(m[3] or 0)
    if h > 23 or mn > 59 or s > 59:
        raise ErreurScenario(f"heure hors bornes : {v!r}")
    return h * 3600 + mn * 60 + s


def lire_date(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    m = re.fullmatch(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*", str(v))
    if m:
        return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    try:
        return dt.date.fromisoformat(str(v).strip()).isoformat()
    except ValueError:
        raise ErreurScenario(f"date illisible : {v!r} (attendu JJ/MM/AAAA)") from None


def lire_nombre(v, nom):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    try:
        return float(str(v).replace(",", ".").strip())
    except ValueError:
        raise ErreurScenario(f"{nom} : nombre illisible {v!r}") from None


def verifier_position(lat, lon, quoi):
    dy = (lat - CENTRE[0]) * 111320
    dx = (lon - CENTRE[1]) * 111320 * math.cos(math.radians(CENTRE[0]))
    if (dx * dx + dy * dy) ** 0.5 > RAYON_MAX_M:
        raise ErreurScenario(f"{quoi} : {lat}, {lon} est à plus de {RAYON_MAX_M} m de la scène")
    return {"lat": round(lat, 7), "lon": round(lon, 7)}


def lire_lieu(v, points):
    """Un nom de la feuille Points, ou « lat, lon » en degrés décimaux."""
    if vide(v):
        raise ErreurScenario("lieu manquant")
    texte = str(v).strip()
    if cle(texte) in points:
        return points[cle(texte)]
    m = re.fullmatch(r"(-?\d+(?:[.,]\d+)?)\s*[;/ ]\s*(-?\d+(?:[.,]\d+)?)", texte) \
        or re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", texte)
    if not m:
        raise ErreurScenario(f"lieu inconnu : {texte!r} (un nom de la feuille Points, ou « lat, lon »)")
    return verifier_position(lire_nombre(m[1], "latitude"), lire_nombre(m[2], "longitude"), texte)


def lignes_dict(lignes):
    """Lignes du tableur (la première est l'en-tête) → (n° de ligne, dict)."""
    lignes = list(lignes)
    if not lignes:
        return []
    entete = [cle(c) if not vide(c) else None for c in lignes[0]]
    sortie = []
    for n, ligne in enumerate(lignes[1:], start=2):
        if all(vide(c) for c in ligne):
            continue
        sortie.append((n, {k: c for k, c in zip(entete, ligne) if k and not vide(c)}))
    return sortie


def convertir(feuilles):
    """feuilles : {nom de feuille : liste de lignes}. Rend le dict de scenario.json."""
    par_cle = {cle(nom): lignes for nom, lignes in feuilles.items()}
    erreurs = []

    reglages = {}
    for ligne in par_cle.get("scenario", []):
        ligne = list(ligne) + [None, None]
        if not vide(ligne[0]):
            reglages[cle(ligne[0])] = ligne[1]
    for requis in ("date", "debut"):
        if vide(reglages.get(requis)):
            erreurs.append(f"Scénario : « {requis} » manquant")

    def essai(quoi, f, *a):
        try:
            return f(*a)
        except ErreurScenario as e:
            erreurs.append(f"{quoi} : {e}")
            return None

    date = essai("Scénario", lire_date, reglages["date"]) if not vide(reglages.get("date")) else None
    debut = essai("Scénario", lire_heure, reglages["debut"]) if not vide(reglages.get("debut")) else None
    fin_saisie = essai("Scénario", lire_heure, reglages["fin"]) if not vide(reglages.get("fin")) else None
    vent = {"de": 270.0, "vitesse": 3.0}       # vent d'ouest, 3 m/s, si rien n'est dit
    if not vide(reglages.get("vent_d_ou")):
        vent["de"] = essai("Scénario", lire_nombre, reglages["vent_d_ou"], "vent") % 360
    if not vide(reglages.get("vent_m_s")):
        vent["vitesse"] = essai("Scénario", lire_nombre, reglages["vent_m_s"], "vent")

    def relatif(s):
        """Une heure avant le début est celle du lendemain."""
        return s + 86400 if debut is not None and s is not None and s < debut else s

    points = {}
    for n, p in lignes_dict(par_cle.get("points", [])):
        quoi = f"Points, ligne {n}"
        if vide(p.get("nom")):
            erreurs.append(f"{quoi} : nom manquant")
            continue
        try:
            points[cle(p["nom"])] = verifier_position(
                lire_nombre(p.get("latitude"), "latitude"), lire_nombre(p.get("longitude"), "longitude"), p["nom"])
        except ErreurScenario as e:
            erreurs.append(f"{quoi} : {e}")

    evenements = []
    for n, e in lignes_dict(par_cle.get("evenements", [])):
        quoi = f"Événements, ligne {n}"
        try:
            type_ = cle(e.pop("type", ""))
            if type_ not in TYPES:
                raise ErreurScenario(f"type {type_!r} inconnu (types : {', '.join(sorted(TYPES))})")
            if "debut" not in e:
                raise ErreurScenario("début manquant")
            t0 = relatif(lire_heure(e.pop("debut")))
            t1 = relatif(lire_heure(e.pop("fin"))) if "fin" in e else None
            if t1 is not None and t1 < t0:
                raise ErreurScenario("fin avant le début")
            ev = {"id": f"e{n}", "type": type_, "debut": t0}
            libelle = e.pop("libelle", None)
            if libelle is not None:
                ev["libelle"] = str(libelle).strip()
            if type_ == "trace":
                raise ErreurScenario("un tracé se dessine dans l'éditeur (editeur.html), pas au tableur")
            if "lieu" in e or type_ not in ("jalon", "phase"):
                ev.update(lire_lieu(e.pop("lieu", None), points))
            params = {k: (v.strip() if isinstance(v, str) else v) for k, v in e.items()}
            for k, v in params.items():
                if isinstance(v, (dt.date, dt.time)):
                    params[k] = str(v)
            if type_ == "fumigene":
                t1 = t1 if t1 is not None else t0 + DUREE_FUMIGENE_S
                couleur = cle(params.pop("couleur", "blanc"))
                if couleur not in COULEURS:
                    raise ErreurScenario(f"couleur {couleur!r} inconnue ({', '.join(sorted(COULEURS))})")
                params["couleur"] = couleur
                params["taille_m"] = lire_nombre(params.get("taille_m", TAILLE_FUMIGENE_M), "taille")
                if "vent_d_ou" in params:
                    params["vent_d_ou"] = lire_nombre(params["vent_d_ou"], "vent") % 360
                if "vent_m_s" in params:
                    params["vent_m_s"] = lire_nombre(params["vent_m_s"], "vent")
            if t1 is not None:
                ev["fin"] = t1
            if params:
                ev["params"] = params
            evenements.append(ev)
        except ErreurScenario as err:
            erreurs.append(f"{quoi} : {err}")

    if erreurs:
        raise ErreurScenario("\n".join(erreurs))
    evenements.sort(key=lambda ev: (ev["debut"], ev["id"]))
    fin = relatif(fin_saisie) if fin_saisie is not None else None
    dernier = max([ev.get("fin", ev["debut"]) for ev in evenements], default=debut)
    if fin is None:
        fin = max(dernier, debut + 3600)
    elif fin < dernier:
        raise ErreurScenario(f"Scénario : la fin précède le dernier événement ({heure_texte(dernier)})")
    return {
        "format": FORMAT, "version": VERSION,
        "titre": str(reglages.get("titre") or "Scénario").strip(),
        "date": date, "debut": debut, "fin": fin, "vent": vent,
        "points": points, "evenements": evenements,
    }


def heure_texte(s):
    s %= 86400
    return f"{s // 3600:02d}:{s // 60 % 60:02d}"


def verifier_json(chemin):
    """Un scenario.json exporté par l'éditeur (editeur.html) : relu tel quel,
    après contrôle de son format, de ses heures et de ses positions."""
    with open(chemin, encoding="utf-8") as f:
        s = json.load(f)
    if not isinstance(s, dict) or s.get("format") != FORMAT:
        raise ErreurScenario("ce fichier n'est pas un scénario")
    if s.get("version") != VERSION:
        raise ErreurScenario(f"version {s.get('version')} du format, attendue {VERSION}")
    if not isinstance(s.get("debut"), (int, float)) or not isinstance(s.get("fin"), (int, float)) \
            or s["fin"] < s["debut"] or not isinstance(s.get("evenements"), list):
        raise ErreurScenario("début, fin ou événements manquants")
    erreurs = []
    for ev in s["evenements"]:
        quoi = f"événement {ev.get('id')} ({ev.get('libelle', '')})"
        try:
            if ev.get("type") not in TYPES:
                raise ErreurScenario(f"type {ev.get('type')!r} inconnu")
            if not isinstance(ev.get("debut"), (int, float)):
                raise ErreurScenario("début manquant")
            if "lat" in ev:
                verifier_position(ev["lat"], ev["lon"], "position")
            params = ev.get("params") or {}
            if ev["type"] == "trace" and len(params.get("points", [])) < 2:
                raise ErreurScenario("tracé de moins de deux points")
            for pt in params.get("points", []):
                verifier_position(pt["lat"], pt["lon"], "point du tracé")
            for pt in params.get("trajet", []):
                verifier_position(pt["lat"], pt["lon"], f"point de {heure_texte(int(pt['t']))}")
        except (ErreurScenario, KeyError, TypeError) as e:
            erreurs.append(f"{quoi} : {e}")
    if erreurs:
        raise ErreurScenario("\n".join(erreurs))
    return s


def lire_xlsx(chemin):
    import openpyxl
    classeur = openpyxl.load_workbook(chemin, data_only=True, read_only=True)
    return {f.title: [list(l) for l in f.iter_rows(values_only=True)] for f in classeur.worksheets}


def ecrire_modele(chemin):
    """Le tableur modèle : un exemple qui se convertit tel quel."""
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
    gras, fond = Font(bold=True), PatternFill("solid", fgColor="DDE6F0")
    wb = openpyxl.Workbook()
    s = wb.active
    s.title = "Scénario"
    for l in [("Clé", "Valeur", "Aide"),
              ("Titre", "Exemple : fumigènes sur Jeoffrécourt", ""),
              ("Date", "24/11/2026", "JJ/MM/AAAA : règle le soleil"),
              ("Début", "06:00", "HH:MM, début de la frise"),
              ("Fin", "07:00", "HH:MM, facultatif ; plus tôt que le début = lendemain"),
              ("Vent (d'où, °)", 270, "direction d'où vient le vent : 0 nord, 90 est, 270 ouest"),
              ("Vent (m/s)", 3, "vitesse du vent")]:
        s.append(l)
    p = wb.create_sheet("Points")
    for l in [("Nom", "Latitude", "Longitude"),
              ("Centre de la scène", 49.5454, 3.9665),
              ("Point nord", 49.5480, 3.9660)]:
        p.append(l)
    e = wb.create_sheet("Événements")
    for l in [("Début", "Fin", "Type", "Lieu", "Libellé", "Couleur", "Taille (m)", "Vent (d'où, °)", "Vent (m/s)"),
              ("06:05", None, "jalon", None, "H : franchissement de la ligne de débouché", None, None, None, None),
              ("06:10", "06:14", "fumigene", "Point nord", "Masque au point nord", "blanc", 20, None, None),
              ("06:20", "06:22", "fumigene", "Centre de la scène", "Signal de ralliement", "rouge", 8, None, None),
              ("06:30", "06:40", "fumigene", "49.5445, 3.9690", "Masque sud-est, vent tourné", "blanc", 25, 200, 5)]:
        e.append(l)
    types = DataValidation(type="list", formula1='"' + ",".join(sorted(TYPES_AFFICHES - {"trace"})) + '"', allow_blank=False)
    couleurs = DataValidation(type="list", formula1='"' + ",".join(sorted(COULEURS)) + '"', allow_blank=True)
    e.add_data_validation(types)
    e.add_data_validation(couleurs)
    types.add("C2:C500")
    couleurs.add("F2:F500")
    for f, largeurs in ((s, (18, 40, 60)), (p, (24, 12, 12)), (e, (8, 8, 11, 24, 44, 9, 10, 14, 11))):
        for c, l in zip(f[1], largeurs):
            c.font, c.fill = gras, fond
            f.column_dimensions[c.column_letter].width = l
        f.freeze_panes = "A2"
    for col in ("A", "B"):
        for c in e[col][1:]:
            c.number_format = "@"
    wb.save(chemin)


def main(argv):
    global CENTRE, RAYON_MAX_M
    argv = list(argv)
    try:
        for option in ("--centre", "--rayon"):
            if option in argv:
                i = argv.index(option)
                valeur = argv[i + 1]
                del argv[i:i + 2]
                if option == "--centre":
                    CENTRE = tuple(float(v) for v in valeur.split(","))
                    assert len(CENTRE) == 2
                else:
                    RAYON_MAX_M = float(valeur)
    except (IndexError, ValueError, AssertionError):
        print("--centre lat,lon et --rayon mètres", file=sys.stderr)
        return 2
    if len(argv) == 3 and argv[1] == "--modele":
        ecrire_modele(argv[2])
        print("Modèle écrit :", argv[2])
        return 0
    if len(argv) != 3:
        print(__doc__)
        return 2
    try:
        scenario = verifier_json(argv[1]) if argv[1].endswith(".json") else convertir(lire_xlsx(argv[1]))
    except ErreurScenario as e:
        print("Scénario refusé :\n" + str(e), file=sys.stderr)
        return 1
    with open(argv[2], "w", encoding="utf-8") as f:
        json.dump(scenario, f, ensure_ascii=False, indent=1)
    reserves = sorted({ev["type"] for ev in scenario["evenements"]} & TYPES_RESERVES)
    print(f"{len(scenario['evenements'])} événement(s), {heure_texte(scenario['debut'])}"
          f"–{heure_texte(scenario['fin'])} → {argv[2]}")
    if reserves:
        print("Sur la frise seulement, pas encore dessinés :", ", ".join(reserves))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
