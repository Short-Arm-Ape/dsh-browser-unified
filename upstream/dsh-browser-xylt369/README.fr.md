# dsh-browser

[English](README.en.md) | [中文](README.md) | [Español](README.es.md) | **Français** | [Русский](README.ru.md) | [العربية](README.ar.md)

Fournit des capacités de navigation web complètes pour [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) : navigation, instantanés d'accessibilité lisibles, clics et saisie de formulaires, onglets multiples, captures d'écran et pièces jointes d'images compatibles avec les modèles de vision.

Hôtes cibles : **dsh `0.1.0-rc.7` / `0.1.1-rc.2`**. Utilise par défaut **Microsoft Edge** local (profil persistant + contournement léger de la détection d'automatisation) et prend en charge le DNS fake-ip de Clash/Surge.

Versions publiées :

| Paquet | Version |
|---|---|
| `@yeesy369/dsh-browser` | `0.6.0` |
| `@yeesy369/dsh-browser-playwright` | `0.8.1` |
| `@yeesy369/dsh-tool-browser` | `0.7.0` |
| `@yeesy369/dsh-web-permission` | `0.6.1` |

Dépôt et notes de version : https://github.com/xylt369/dsh-browser/releases/tag/v0.8.1

---

## Installation

1. Vérifiez que `dsh` est installé (`dsh --version`). Si ce n'est pas le cas, exécutez `npm i -g @deepseek-ai/dsh`.
2. Installez les plugins :

```sh
dsh plugin --profile web add \
  @yeesy369/dsh-browser-playwright@0.8.1 \
  @yeesy369/dsh-tool-browser@0.7.0 \
  @yeesy369/dsh-web-permission@0.6.1
```

3. Redémarrez `dsh web`.
4. Demandez à l'agent d'ouvrir une page web dans la conversation. Si une connexion est requise, connectez-vous une seule fois dans la fenêtre Edge qui s'affiche (l'état est conservé dans `~/.dsh/edge-profile`).

Pour mettre à niveau une installation existante, utilisez la commande `plugin add` ci-dessus avec les numéros de version, puis redémarrez `dsh web`.

---

## Interface de configuration (0.8.x)

L'accès à la configuration se fait via **dsh Web → Paramètres → Configuration des plugins**. Après l'installation et le redémarrage, deux cartes officielles de plugins apparaîtront sur cette page (l'édition manuelle de YAML n'est plus la voie principale).

### Porte d'autorisation web

Contrôle les hôtes auxquels les outils de navigation et d'extraction peuvent accéder. Les modifications prennent effet **immédiatement** après enregistrement (rechargement à chaud).

| Contrôle | Description |
|---|---|
| Hôtes autorisés | Un nom d'hôte par ligne ; l'accès est accordé en cas de correspondance |
| Hôtes refusés | Un nom d'hôte par ligne ; prioritaire sur la liste des autorisations (inclut par défaut `localhost`, `metadata.google.internal`) |
| Noms des outils contrôlés | Liste des outils dont l'argument `url` est vérifié (ex. `browser_navigate`, `browser_fill`, `web_fetch`) |
| Action par défaut pour les hôtes non répertoriés | `Autoriser` ou `Demander` |
| Ajouter à la liste des autorisations après approbation | En mode `Demander`, ajoute automatiquement l'hôte à la liste autorisée après approbation de l'utilisateur |

Le bas de la carte propose **Abandonner** / **Enregistrer** ; les champs personnalisés peuvent être **Réinitialisés aux valeurs par défaut**.

### Fenêtre du navigateur

Contrôle le mode de lancement de Playwright et la compatibilité réseau. Les modifications prennent effet après **un redémarrage de dsh** ou lors du **prochain lancement du navigateur**.

| Contrôle | Description |
|---|---|
| Mode de fenêtre | `Fenêtre visible` / `Fenêtre masquée` / `Headless (Sans tête)` |
| Correctif léger anti-détection | Activé par défaut (supprime les empreintes d'automatisation courantes) |
| Autoriser le DNS fake-ip du proxy | Activé par défaut ; autorise les réponses de résolution `198.18.0.0/15` de Clash/Surge |

| Mode de fenêtre | Scénarios recommandés | Remarques |
|---|---|---|
| Fenêtre visible | Connexion manuelle, captchas, retour visuel direct | Occupe une fenêtre sur le bureau |
| Fenêtre masquée | Vrai navigateur, ne perturbe pas le bureau | Fenêtre non visible directement ; nécessite une session de bureau |
| Headless | Serveurs / CI | Les sites à forte protection peuvent détecter le mode ; pas de connexion manuelle |

Le paquet optionnel `@yeesy369/dsh-browser-settings` fournit un panneau latéral. Pour la configuration quotidienne, privilégiez les cartes de configuration des plugins ci-dessus.

---

## Fonctionnalités disponibles pour le modèle

| Capacité | Outil / Comportement |
|---|---|
| Ouvrir une page | `browser_navigate` (filtré par le pare-feu d'URL) |
| Lire une page | `browser_snapshot` (avec références cliquables telles que `e1`, `f29e86`) |
| Interaction | `browser_click` / `type` / `fill` / `press` / `scroll` / `wait` / `back` / `forward` |
| Onglets multiples | `browser_tabs` / `open_tab` / `switch_tab` / `close_tab` (isolé par session) |
| Capture d'écran | `browser_screenshot` → pièce jointe durable + ContentBlock `image` (exploitable par les modèles de vision) |
| JS dans la page | `browser_evaluate` (désactivé par défaut ; à activer explicitement via YAML / `cordis.patch.yml`) |

---

## Modèle de sécurité

- Seul le protocole `http(s)` public est autorisé ; les adresses privées, de bouclage, link-local et de métadonnées cloud sont bloquées (`packages/browser-playwright/src/url-guard.ts`).
- Le DNS fake-ip de proxy (`198.18.0.0/15`) est autorisé par défaut ; les plages privées réelles restent bloquées. Désactivable dans la carte « Fenêtre du navigateur ».
- La porte d'autorisation est réglée par défaut sur « Autoriser » pour les hôtes non répertoriés ; passez à « Demander » pour exiger une validation manuelle.
- Le module anti-détection est une solution légère et ne garantit pas le contournement de toutes les protections anti-robots.

YAML / `cordis.patch.yml` restent valables pour la configuration de déploiement ; les cartes Web écrivent dans le même espace de noms de configuration.

---

## Rôles des paquets

| Paquet | Rôle |
|---|---|
| `@yeesy369/dsh-browser` | Définition du service : `ctx.browser` |
| `@yeesy369/dsh-browser-playwright` | Implémentation Playwright + Carte « Fenêtre du navigateur » |
| `@yeesy369/dsh-tool-browser` | Outils `browser_*` mis à disposition du modèle |
| `@yeesy369/dsh-web-permission` | Porte de permissions `tools/pre-execute` + Carte « Porte d'autorisation web » |
| `@yeesy369/dsh-browser-settings` | Panneau latéral optionnel |

---

## Optionnel : YAML / Options avancées

La plupart des réglages doivent être effectués dans les cartes de l'interface Web. La configuration YAML ci-dessous est réservée aux déploiements automatisés ou aux champs non encore présents dans l'interface :

```yaml
# $DSH_HOME/settings.yaml — web-permission (mise à jour à chaud)
web-permission:
  defaultAction: ask
  remember: true
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: browser-playwright
  config:
    windowVisibility: visible
    stealth: true
    allowFakeIp: true
- id: tool-browser
  config:
    evaluate: false
```

---

## Développement

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

Documentation : [Architecture](./docs/architecture.md) · [Contribution et publication](./CONTRIBUTING.md) · [AGENTS](./AGENTS.md) · [Licence MIT](./LICENSE)

Désinstallation :

```sh
dsh plugin --profile web remove \
  @yeesy369/dsh-browser-playwright \
  @yeesy369/dsh-tool-browser \
  @yeesy369/dsh-web-permission
```
