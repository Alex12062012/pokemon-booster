# Bourse aux Boosters

Ouvre des boosters virtuels de cartes Pokémon : vraies cartes, vraies photos, vraies cotes Cardmarket.

- `scripts/build-data.mjs` récupère toutes les cartes et leurs cotes via l'API pokemontcg.io et écrit `public/cards.json`.
- `public/engine.js` contient les taux de tirage et le calcul du prix du booster.
- Le site est publié sur GitHub Pages à chaque push, et les cotes sont rafraîchies chaque lundi.

Jeu non officiel, sans lien avec The Pokémon Company ni Cardmarket.
