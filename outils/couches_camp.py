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
    "troncon_de_route": ("nature", "importance", "largeur_de_chaussee", "nombre_de_voies",
                         "acces_vehicule_leger", "position_par_rapport_au_sol", "restriction_de_poids_total",
                         "restriction_de_largeur", "nom_collaboratif_gauche", "etat_de_l_objet",
                         "itineraire_vert", "periode_de_fermeture"),
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


def couches_protegees():
    """Les noms des couches PROTECTEDAREAS.* du WFS de la Géoplateforme."""
    xml = get(f"{URL_WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities").text
    racine = ET.fromstring(xml)
    noms = []
    for ft in racine.iter("{http://www.opengis.net/wfs/2.0}FeatureType"):
        nom = ft.findtext("{http://www.opengis.net/wfs/2.0}Name") or ""
        titre = ft.findtext("{http://www.opengis.net/wfs/2.0}Title") or ""
        if nom.upper().startswith("PROTECTEDAREAS"):
            noms.append((nom, titre))
    return noms


def inventaire(zone):
    autour = elargir(zone, MARGE_M)
    for nom, titre in couches_protegees():
        objets = wfs(nom, autour)
        print(f"\n== {nom} ({titre}) : {len(objets)}")
        if objets:
            print("   attributs :", sorted(objets[0]["properties"]))
            for f in objets[:12]:
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


def main(argv):
    if len(argv) >= 3 and argv[1] == "inventaire":
        inventaire(lire_zone(argv[2]))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
