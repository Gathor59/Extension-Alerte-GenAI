# Fichiers de langue

Un fichier par langue, `locales/<code>.json`, et un index `locales/index.json`.

## Ajouter une langue (ex. allemand)

1. Copier `fr.json` (ou `en.json`) en `de.json` et traduire les valeurs. Ne pas toucher aux clés.
2. Dans `de.json`, mettre à jour `_meta.code` et `_meta.name`.
3. Ajouter une entrée dans `index.json` :
   `{ "code": "de", "label": "DE", "name": "Deutsch" }`

Aucun changement de code n'est nécessaire : le bouton de langue apparaît dans la page
d'options, et la langue est choisie automatiquement selon le navigateur (`de-CH` -> `de`).

## Règles

- Les `{variables}` (ex. `{count}`, `{status}`) doivent rester identiques dans toutes les langues.
- Une clé absente d'une langue est lue dans la langue par défaut (`default` dans `index.json`).
- Les textes de `alert_messages` contiennent des balises `<br>` : les conserver.
- Les liens (`infoUrl`) ne sont pas traduits, ils sont dans `service-worker.js`.
