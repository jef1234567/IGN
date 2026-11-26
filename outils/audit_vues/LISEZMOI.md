# Audit des calculs de vue

La page juge ce qui se voit de trois façons : la ligne de vue (lancer de rayon,
`interface/mission.js`), la carte des vues (carte de distances cubique, même
module) et la grille de hauteurs du bréchage (`interface/brechage.js`). Cet
audit les confronte à une référence indépendante, en Python, qui suit chaque
ligne pas à pas de 1 m sur le relief vrai, analytique (`monde.py`).

Le monde : une pente, deux crêtes, une colline, un talus de 5 m et un bâtiment
de 12 m ; la scène fine fait 650 × 1 000 m, le reste est servi à la page en
tuiles RGE ALTI fabriquées depuis `monde.py`. Il éprouve donc aussi le relief
de calcul au-delà de la scène (`interface/reliefcalcul.js`), et la courbure.

```bash
python outils/audit_vues/faire_scene.py          # scene.json
python outils/audit_vues/serveur.py &            # la page, port 8766
THREE_DIR=/chemin/vers/three node outils/audit_vues/audit.cjs   # page.json (playwright)
python outils/audit_vues/reference.py            # le bilan
```

Bilan du 26 novembre 2026 (1 260 jugements) : aucun désaccord hors des lignes
rasantes, celles qui passent à moins de 0,5 m + 2 ‰ de la distance du sol.
Le relief y est lu à 12 × 19 m (le niveau 12 du RGE ALTI que garde un camp
hors réseau), et la carte cubique a un biais de 0,3 m + 2 ‰ : à moins de cela,
le verdict tient du relief exact, que ni la page ni l'IGN ne connaissent.
