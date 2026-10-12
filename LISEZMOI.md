# Nernier — Suivi projet : site Netlify

Ce dossier contient le site de suivi du projet YS2 Nernier : la même page que l'artifact claude.ai, protégée par un identifiant et un code d'accès, et partagée en direct entre les personnes connectées (commentaires de séance, budget, factures).

Les données ne sont pas dans les fichiers du site : elles sont stockées par Netlify (Netlify Blobs). Mettre le site à jour chaque semaine ne demande donc aucun redéploiement : on importe simplement le fichier envoyé par Claude depuis le site lui-même.

## Contenu du dossier

| Élément | Rôle |
|---|---|
| `netlify/page/index-html.mjs` | La page de suivi (identique à l'artifact), servie uniquement après connexion |
| `public/login.html` | La page de connexion |
| `public/nernier-runtime.js` | Le moteur du site : lecture et écriture des données, barre de session, import et export |
| `netlify/functions/api.mjs` | Le serveur : connexion, page protégée, données partagées, import et export |
| `netlify.toml`, `package.json`, `package-lock.json` | La configuration Netlify |
| `mettre-en-ligne.cmd` | Variante sans GitHub : met en ligne depuis un PC Windows (double-clic) |

## Mise en ligne (une seule fois, environ 15 minutes)

### 1. Mettre le dossier sur GitHub

- Créer un compte gratuit sur github.com si besoin.
- En haut à droite, cliquer sur **+** puis **New repository**. Nom : `nernier-suivi`. Cocher **Private**. Ne rien ajouter d'autre, puis cliquer sur **Create repository**.
- Sur la page du dépôt vide, cliquer sur le lien **uploading an existing file**.
- Ouvrir le dossier `nernier-suivi-site` décompressé et sélectionner **tout son contenu** (Ctrl+A). Glisser la sélection dans la page GitHub. Il faut glisser le contenu du dossier, pas le dossier lui-même : `netlify.toml` doit apparaître à la racine du dépôt.
- En bas de la page, cliquer sur **Commit changes**.

### 2. Créer le site sur Netlify

- Sur app.netlify.com, cliquer sur **Add new project**, puis **Import an existing project**, puis **GitHub**.
- Autoriser Netlify à accéder à GitHub. Il suffit de lui donner accès au seul dépôt `nernier-suivi` (option **Only select repositories**). Choisir ensuite ce dépôt.
- Les réglages sont lus dans `netlify.toml` : laisser le champ *Build command* vide.
- Cliquer sur **Add environment variables**, puis sur **New variable**, et créer :
  - Clé : `NERNIER_ACCES`
  - Valeur : une personne par bloc, les blocs séparés par un point-virgule, au format `identifiant | code d'accès | Nom affiché | rôle`. Exemple :

    ```
    stanislas | CODE-A-CHOISIR-1 | Stanislas Lethu | admin ; michael | CODE-A-CHOISIR-2 | Michaël Bertini | edition ; fabien | CODE-A-CHOISIR-3 | Fabien Bertini | edition ; sophie | CODE-A-CHOISIR-4 | Sophie Bourguignon | lecture ; cyrille | CODE-A-CHOISIR-5 | Cyrille Fontaine | edition
    ```

- Cliquer sur **Deploy**. La mise en ligne prend environ une minute.

Si le bouton **Add environment variables** n'apparaît pas, créer la variable après la mise en ligne : aller dans **Project configuration**, puis **Environment variables**, puis **Add a variable**. Lancer ensuite **Deploys**, puis **Trigger deploy**, puis **Deploy project**.

Les trois rôles :

| Rôle | Peut faire |
|---|---|
| `admin` | Tout, y compris importer la mise à jour de Claude, exporter pour Claude et annuler un import |
| `edition` | Commenter en séance, modifier le budget et les factures |
| `lecture` | Consulter uniquement |

Choisir des codes d'au moins 10 caractères. Après 8 erreurs depuis une même connexion, l'identifiant est bloqué 15 minutes sur cette connexion.

### 3. Donner une adresse lisible

Aller dans **Project configuration**, puis **General**, puis **Project details**, et cliquer sur **Change project name**. Saisir par exemple `nernier-suivi`. L'adresse devient alors https://nernier-suivi.netlify.app (si le nom est déjà pris, en choisir un autre).

### 4. Charger les données

- Ouvrir l'adresse du site et se connecter avec l'identifiant `admin`.
- Dans la barre noire en haut, cliquer sur **Importer les données**, puis choisir le fichier `nernier-donnees-AAAA-MM-JJ.json` envoyé par Claude.
- Vérifier l'aperçu, puis cliquer sur **Appliquer la mise à jour**.

Le site est prêt. Il reste à communiquer l'adresse, l'identifiant et le code à chaque personne.

## Chaque semaine (environ 2 minutes)

1. En séance, commenter directement sur le site, dans l'onglet *Plan d'actions*, avec la bulle à droite de chaque action. Le budget et les factures se modifient aussi sur le site. Chaque personne connectée voit les changements en moins de 15 secondes, sans recharger la page.
2. Après la séance, cliquer sur **Exporter pour Claude** dans la barre noire. Envoyer le fichier téléchargé (`nernier-export-site-….json`) à Claude avec les comptes rendus.
3. Claude met à jour l'artifact (statuts, planning, budget, comptes rendus, commentaires de séance) et renvoie un fichier `nernier-maj-AAAA-MM-JJ.json`.
4. Sur le site, cliquer sur **Importer la mise à jour**, choisir ce fichier, vérifier l'aperçu, puis **Appliquer la mise à jour**.

À l'import, les modifications faites sur le site après l'export envoyé à Claude ne sont pas écrasées. L'aperçu les liste dans la colonne **Conservés** ; il suffit de les renvoyer à Claude avec l'export suivant.

En cas d'erreur, cliquer sur **Annuler le dernier import** pour revenir à l'état d'avant. Chaque import enregistre aussi une copie complète des données dans Netlify (Blobs, store `nernier-suivi`, dossier `historique/`).

## Gérer les accès

Pour ajouter une personne, changer un code ou retirer quelqu'un :

- Aller dans **Project configuration**, puis **Environment variables**, et modifier `NERNIER_ACCES`.
- Aller ensuite dans **Deploys**, cliquer sur **Trigger deploy**, puis sur **Deploy project**. Les changements ne s'appliquent qu'après ce redéploiement.

Une personne retirée ou dont le code a changé est déconnectée immédiatement ; les autres restent connectées. Pour déconnecter tout le monde, ajouter une variable `NERNIER_SECRET` avec une longue chaîne aléatoire, ou changer sa valeur, puis redéployer.

## Faire évoluer la page

Quand Claude modifie la présentation, il fournit les fichiers mis à jour (le plus souvent `netlify/page/index-html.mjs`). Pour les installer :

- Dans le dépôt GitHub, ouvrir le dossier concerné (par exemple `netlify/page`).
- Cliquer sur **Add file**, puis **Upload files**, et glisser le fichier.
- Cliquer sur **Commit changes**.

Netlify redéploie alors automatiquement en environ une minute. Les données ne sont pas touchées.

Sans GitHub, il est aussi possible de mettre en ligne depuis un PC Windows avec Node.js installé. Il suffit de double-cliquer sur `mettre-en-ligne.cmd` : la première fois, choisir **Create & configure a new project**, ou **Link this directory to an existing project** si le projet existe déjà. Le glisser-déposer d'un dossier sur Netlify ne fonctionne pas pour ce site, car il ne met pas en ligne la partie serveur.

Coût : le plan gratuit de Netlify compte en crédits. Chaque redéploiement consomme 15 crédits, alors que les imports hebdomadaires n'en consomment presque pas, puisqu'ils ne redéploient rien.

## En cas de problème

| Symptôme | Solution |
|---|---|
| « Aucun accès n'est configuré » | La variable `NERNIER_ACCES` est absente ou mal nommée. La corriger, puis redéployer. |
| « Identifiant ou code d'accès incorrect » | Vérifier les espaces et les `\|` dans la variable. L'identifiant ne tient pas compte des majuscules, le code si. |
| Pastille orange dans la barre noire | Connexion interrompue. Le site réessaie tout seul. |
| Le déploiement échoue sur Netlify | Ouvrir le déploiement dans **Deploys** et envoyer le message d'erreur à Claude. Vérifier que `netlify.toml` est bien à la racine du dépôt GitHub. |
| La page reste sur « Chargement… » | Recharger la page. Si le problème persiste, ouvrir **Logs**, puis **Functions** dans Netlify, et transmettre le message à Claude. |
