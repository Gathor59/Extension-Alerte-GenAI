# Trois paquets à partir d'un seul code

| Paquet | Dossier généré | `manifest.version` | Pour | Contenu |
|---|---|---|---|---|
| Standard | `dist/standard/` | `3.1.2` | Chrome, Edge | l'extension publique |
| Firefox | `dist/firefox/` | `3.1.2` | Firefox | la version standard, avec un manifeste adapté à Firefox |
| Safari | `dist/safari/` | `3.1.2` | Safari (macOS) | la version standard, avec un manifeste adapté à Safari |

Les paquets Firefox et Safari = la version standard dont **seul le manifeste** change (`firefoxManifest`, `safariManifest`). Tout le reste est copié à l'identique depuis la racine.

## Le paquet Firefox

Le manifeste Firefox diffère du standard par quatre points, et par rien d'autre :

| Clé | Chrome / Edge | Firefox | Pourquoi |
|---|---|---|---|
| `background` | `service_worker` | `scripts: [browser-polyfill.min.js, i18n.js, service-worker.js]` | Firefox n'accepte pas `service_worker`; il exécute les scripts comme une page de fond (une seule portée, sans `importScripts`). L'ordre compte: sans `i18n.js` avant `service-worker.js`, les textes retombent sur leurs clés. |
| `update_url` | présent (Chrome Web Store) | absent | inutilisé par Firefox (mises à jour via le site des modules) |
| `browser_specific_settings.gecko.id` | absent | `sebastien@gavois.fr` | obligatoire en MV3. C'est l'ID **déjà enregistré sur AMO** pour cette extension: AMO refuse tout paquet dont l'ID diffère (« The add-on ID in your manifest.json does not match the ID of your add-on on AMO »). Définitif: ne jamais le changer. Fichier: `variants/firefox/gecko-id.txt` (le build vérifie que le manifeste et ce fichier concordent) |
| `browser_specific_settings.gecko.data_collection_permissions` | absent | `required: [none]`, `optional: [websiteActivity, personallyIdentifyingInfo]` | exigé par AMO pour toute nouvelle soumission. Seul le formulaire de signalement envoie des données (URL signalée, e-mail facultatif), uniquement sur action de l'utilisateur. |

### Ce qui a été vérifié

- `web-ext lint` (outil officiel de Mozilla): **0 erreur**.
- Chargement du code de fond dans une page simulée sans `importScripts`, avec `browser` natif: démarre sans exception avec le vrai module de traduction.
- Le build échoue si le manifeste Firefox n'est pas exactement « standard + delta », si `i18n.js` ne précède pas `service-worker.js`, si l'ID est absent ou mal formé, ou si un fichier référencé manque.

### Ce qui N'A PAS été vérifié

- **Aucun test dans un vrai Firefox.** La machine de développement n'avait pas `libgtk-3`. Il faut charger `dist/firefox/manifest.json` via `about:debugging#/runtime/this-firefox` et vérifier que les listes se chargent.
- **Deux avertissements `web-ext lint`** restent: `data_collection_permissions` n'est reconnue qu'à partir de Firefox 140 (142 sur Android) alors que `strict_min_version` est `121.0`. Monter la version minimale à 140 les supprime mais exclut Firefox ESR 128. Choix non tranché; à ne pas faire sans décision explicite.
- Le comportement des Firefox 121 à 139 face à cette clé n'a pas pu être confirmé dans la documentation de Mozilla.
- La page de fond Firefox est **non persistante** (event page): les variables globales du service worker sont perdues quand elle s'arrête. Le code recharge son état depuis `storage.local` (`reinitializeVariables`), comme avec le service worker de Chrome; non testé dans Firefox.

### Tester sur un poste

```
node build.js
```
puis, dans Firefox: `about:debugging#/runtime/this-firefox` -> « Charger un module complémentaire temporaire » -> `dist/firefox/manifest.json`.
Pour un contrôle automatique: `npx web-ext lint --source-dir dist/firefox`.

## Le paquet Safari (macOS)

Même principe que Firefox: les 19 autres fichiers sont identiques, seul le manifeste change. Sources: la page d'Apple
« Assessing your Safari web extension's browser compatibility » et les données MDN `browser-compat-data`.

| Clé | Chrome / Edge | Safari | Pourquoi |
|---|---|---|---|
| `background` | `service_worker` | `scripts: [browser-polyfill.min.js, i18n.js, service-worker.js]` | `scripts` est supporté depuis Safari 14 (`service_worker` depuis 15.4); même ordre de chargement que Firefox |
| `update_url` | présent | absent | Apple: « Not supported. Handle updates with the App Store. » |
| `permissions.notifications` | présente | absente | l'API `notifications` n'existe pas dans Safari (MDN) |
| `browser_specific_settings` | `gecko` | `safari: { strict_min_version: "15.4" }` | 15.4 = première version avec `action`, `action.default_popup` et `web_accessible_resources.matches/resources` |

### Conséquences pour l'utilisateur de Safari

- **Pas de notification système.** Les alertes « listes non chargées » passent par le badge `!` de l'icône et le bandeau du popup.
- **Permission par site.** D'après MDN, Safari n'applique pas les content scripts à un onglet tant que l'utilisateur n'a pas accordé l'accès dans la fenêtre de l'extension (barre d'outils). L'alerte modale n'apparaît donc qu'après cette autorisation.
- **Stockage.** `storage.local` est limité à 5 Mo dans Safari (Apple). L'extension stocke environ 1,9 Mo avec les listes de production (mesuré): marge suffisante.

### Ce qui a été vérifié

- Le build échoue si le manifeste Safari n'est pas exactement « standard + delta Safari », s'il contient `update_url`, `service_worker` ou `notifications`, ou si `i18n.js` ne précède pas `service-worker.js`.
- Simulation du code de fond avec le vrai manifeste Safari, sans `importScripts` et sans `browser.notifications`: démarre sans exception, le badge d'erreur `!` s'affiche, l'état d'alerte est enregistré.

### Ce qui N'A PAS été vérifié

- **Aucun test dans un vrai Safari.** Il n'y a pas de Mac sur la machine de développement. Le paquet n'a jamais été chargé dans Safari, ni passé dans l'outil d'Apple `xcrun safari-web-extension-packager`.
- Le comportement exact de `options_ui.open_in_tab` et du popup dans Safari.
- Toute l'API utilisée n'est pas listée comme « non supportée » par Apple, mais « non listée » ne prouve pas « supportée »: à confirmer à l'exécution.

### Tester sur un Mac

```
node build.js
```
puis, dans Safari: Réglages -> Développeur -> « Ajouter une extension temporaire… » -> dossier `dist/safari`.
L'extension disparaît au bout de 24 h ou à la fermeture de Safari. Cocher « Autoriser les extensions non signées » si demandé
(à refaire à chaque lancement de Safari). Sur un MacBook Pro 13" à deux ports Thunderbolt 3 (macOS Sequoia au maximum),
le dernier Xcode utilisable est le 26.3 (macOS 15.6 minimum), suffisant pour `xcrun safari-web-extension-packager`.

## Règle de parité

Ne jamais modifier `dist/`. On modifie la racine (code commun), `variants/firefox/`, puis :

```
node build.js          # construit les trois paquets ET vérifie la parité
node build.js --check  # vérifie seulement
```

`build.js` échoue si :
- un fichier commun diffère entre les trois paquets (hors manifestes) ;
- un fichier est ajouté ou retiré en dehors du delta déclaré ;
- le manifeste Firefox n'est pas exactement « standard + delta Firefox » (voir plus haut) ;
- le manifeste Safari n'est pas exactement « standard + delta Safari », ou contient `update_url`, `service_worker` ou `notifications` ;
- `fr.json` et `en.json` n'ont pas les mêmes clés ;
- un fichier référencé par un manifeste est absent.

## Changer la version

Modifier `version` dans `manifest.json` (racine) .

