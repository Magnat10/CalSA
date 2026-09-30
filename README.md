# FICSIT Production Planner

## Dateien
- index.html: Benutzeroberflaeche
- style.css: Styling
- app.js: UI, SCIM-Filter, Icon-Registry, Interaktionen
- calculator.js: Produktionsberechnung
- scim-item-whitelist.json: erlaubte Produkte
- icons.json: ID-basierte Icon-Zuordnung
- DocsRecipes.json: Rezeptdaten, muss neben index.html liegen
- assets/icons/: spaetere echte WebP-Icons

## Lokal starten
Da JSON per fetch() geladen wird, die App ueber einen lokalen HTTP-Server starten, z. B.:

    python3 -m http.server 8080

Dann im Browser http://localhost:8080 oeffnen.

## Icons
Echte Icons spaeter entsprechend icons.json in assets/icons/items, ores und machines ablegen.
Fehlende Icons verwenden automatisch das SVG-Fallback.
