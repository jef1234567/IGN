# Audit des calculs de vue (outils/audit_vues) : le monde synthétique.
import math
LAT0, LON0 = 49.5454, 3.9665
MLAT = 111320.0
MLON = 111320.0 * math.cos(math.radians(LAT0))
R_APP = 6371000 / (1 - 0.13)
DEMI_LAT, DEMI_LON = 500 / 111320, 500 / 111320   # emprise de la scène, comme faire_scene.py

def xy(lon, lat):
    return (lon - LON0) * MLON, (lat - LAT0) * MLAT

def sol(x, y):
    """Altitude vraie (m) : pente, crête nord-sud en x=0, crête en x=900, colline en (-300, 1200)."""
    return (150 - 0.01 * x + 25 * math.exp(-(x / 60) ** 2) + 40 * math.exp(-((x - 900) / 120) ** 2)
            + 30 * math.exp(-((x + 300) ** 2 + (y - 1200) ** 2) / 200 ** 2)
            + 5 * math.exp(-((x + 600) / 30) ** 2))   # talus de 5 m en x = −600, hors de la scène

BATI = (-160.1, -140.1, -10.0, 10.0, 163.6)    # x0, x1, y0, y1, toit (m)

def dans_scene(lon, lat):
    return abs(lon - LON0) <= DEMI_LON and abs(lat - LAT0) <= DEMI_LAT
