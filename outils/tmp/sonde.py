import json, urllib.request
for t in ["lieu_dit_non_habite", "zone_d_habitation", "detail_orographique", "toponymie_lieux_nommes",
          "toponymie_voies_nommees", "troncon_de_route", "route_numerotee_ou_nommee"]:
    url = ("https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:" + t
           + "&COUNT=2&OUTPUTFORMAT=application/json&BBOX=43.68,6.40,43.72,6.48,urn:ogc:def:crs:EPSG::4326")
    try:
        d = json.load(urllib.request.urlopen(url, timeout=60))
        print("==", t, d.get("numberMatched"))
        for x in d.get("features", []):
            print("  ", x["geometry"]["type"], {k: v for k, v in x["properties"].items() if v not in (None, "")})
    except Exception as e:
        print("==", t, "ERREUR", e)
