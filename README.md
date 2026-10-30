# Extension Next.ink : alerte sur les sites GenAI

En marge de [l’enquête de Jean-Marc Manach sur des médias en français générés par IA](https://next.ink/153613/enquete-plus-de-1-000-medias-en-francais-generes-par-ia-polluent-le-web-et-google/) nous avons développé une extension pour Chrome, Edge et Firefox (y compris en version mobile sur Android), ainsi qu'un paquet pour Safari sur Mac, afin d’être alerté lorsque vous visitez un des sites que nous avons identifiés (à la main).

Au fil des semaines, la liste a continué de s’enrichir, dépassant allégrement les 1 500 puis les 2 000 et maintenant 3 000 domaines… et ce n’est pas fini ! En plus de nouvelles listes, nous avons ajouté une mise à jour automatique de la liste dans la version 2.0 de notre extension. Cette extension a été développée à l’aide de l’IA générative Claude, avec une supervision humaine.

## Télécharger notre extension depuis les Web Store :

- [Télécharger et installer notre extension pour Firefox](https://addons.mozilla.org/fr/firefox/addon/alerte-sur-les-sites-genai/)
- [Télécharger et installer notre extension pour Chrome](https://chromewebstore.google.com/detail/alerte-sur-les-sites-gena/bcmpghnhminmlljeomngepamejbopffc?authuser=0&hl=fr)

Une version pour Safari (macOS) est en préparation : le paquet existe dans ce dépôt mais n'est pas encore publié sur l'App Store.

## Ce que fait l'extension

- Affiche une alerte lorsque vous visitez un site présent dans l'une des listes surveillées : médias en français générés par IA, médias en anglais générés par IA, [Red Flag Domains](https://red.flag.domains/), liste noire de l'[AMF](https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde) et sanctions de la [DGCCRF](https://www.economie.gouv.fr/dgccrf/laction-de-la-dgccrf/injonctions-et-sanctions), chacune avec son message d'alerte.
- Détecte les attaques par homographes IDN (caractères internationaux qui imitent des lettres latines).
- Permet de ne plus être alerté sur certains domaines.
- Met à jour les listes périodiquement, et signale une erreur de mise à jour par un badge sur l'icône et un bandeau dans la fenêtre de l'extension.
- Interface en français et en anglais.
- Permet de signaler un site à l'équipe depuis la fenêtre de l'extension, ou par e-mail à genai@next.ink si l'envoi échoue.

## Données et confidentialité

La vérification d'un site se fait **dans votre navigateur**, à partir des listes téléchargées : les adresses que vous visitez ne sont pas envoyées à un serveur.

Seul le formulaire de signalement envoie des données, et uniquement quand vous cliquez sur le bouton : l'adresse du site signalé (sans paramètres, sans fragment ni identifiants), le motif que vous saisissez, votre e-mail si vous le renseignez (facultatif), ainsi que des informations techniques (version de l'extension, navigateur, versions et tailles des listes).

## Le code

L'extension est écrite en JavaScript (Manifest V3), sans dépendance à installer. Le même code sert pour trois paquets, qui ne diffèrent que par leur fichier `manifest.json` :

| Paquet | Dossier généré | Pour |
|---|---|---|
| Standard | `dist/standard/` | Chrome, Edge |
| Firefox | `dist/firefox/` | Firefox |
| Safari | `dist/safari/` | Safari (macOS) |

Pour les construire et vérifier qu'ils restent identiques hors manifeste :

```
node build.js          # construit les trois paquets et vérifie leur parité
node build.js --check  # vérifie seulement
```

Les détails de chaque paquet (différences de manifeste, limites, ce qui a été testé ou non) sont dans [`variants/README.md`](variants/README.md). Les traductions sont dans [`locales/`](locales/README.md) : pour ajouter une langue, créez `locales/<code>.json` et déclarez-la dans `locales/index.json`.

Le fichier `bloom-filter.json` fourni ici n'est qu'un petit fichier d'amorçage : les vraies listes sont téléchargées par l'extension.

## Développé avec une IA et l’aide de plusieurs devs de moji 

L’extension a été développée avec l’aide de [Hezirem](https://github.com/hezirem) qui s’est occupé de toute la partie obsucation de la liste, merci 1000x à lui ! Merci également aux devs de moji qui ont patientement répondus à mes questions et demandes, parfois intelligentes, mais trop peu souvent malheureusement ^^

Au fil des versions, l’extension peut maintenant ne plus afficher d’alertes sur certains domaines, propose une mise à jour automatique et périodique des listes et intègre les listes de Red Flag Domains et celles de l’Autorité des marchés financiers (AMF), avec des messages d’alertes personnalisés.

Le code est géré est maintenu par moi même. Disclaimer : je ne suis pas développeur, donc n’hésitez pas à me proposer des pistes d’améliorations. Dans la mesure du possible et de mes connaissances, je tâcherais d’y répondre. 

Les icônes ont été réalisées par Flock, en plus des images d’illustrations des articles sur notre extension. 

## Pourquoi la liste n’est pas publique ?

C’est une question qui revient régulièrement, à juste titre. Jean-Marc s’est déjà exprimé sur le sujet : « nous ne rendons pas publique l'intégralité de la liste de ces sites, pas plus que celle des entreprises, pour plusieurs raisons. Nous ne voulons pas, d'une part, que cette base de données puisse aider ceux qui voudraient améliorer leurs générateurs d'articles automatisés, et qui se targuent de ne pas être reconnus comme GenAI ».

Nous ne voulons pas, d'autre part, faire de "name & shame" et mettre sur le même plan les auto-entrepreneurs individuels ayant lancé un ou deux sites de ce type et les entreprises en ayant industrialisé le process.

## Licence

Apache License 2.0, voir le fichier [LICENSE](LICENSE).
