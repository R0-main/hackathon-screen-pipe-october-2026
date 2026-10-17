# Héberger le cerveau sur une machine de l'entreprise

> Le cerveau tourne chez vous, sur un ordinateur de l'entreprise toujours allumé, et les postes le joignent sur le
> réseau local en HTTPS. Rien ne sort de l'entreprise : ni les captures (qui restent sur chaque poste), ni le distillé
> (qui reste sur cette machine). Le cloud ([README](../README.md#déployer-le-cerveau-partagé-vercel--neon-offres-gratuites))
> devient une option, pas un prérequis.

## En trois commandes

```bash
git clone <ce dépôt> && cd hackathon-screen-pipe-october-2026
sh deploy/local/brain-local.sh up      # écrit .env, construit l'image, démarre Postgres + cerveau + Caddy, affiche l'adresse
sh deploy/local/brain-local.sh status  # plus tard : état et adresses
```

Prérequis : [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS, Windows) ou Docker Engine avec
Compose v2 (Linux), les ports 80 et 443 libres sur la machine, et `openssl` (présent sur macOS et Linux). La première
construction prend quelques minutes (elle télécharge les dépendances et les polices) ; les suivantes sont rapides.

À la fin, le script affiche :

- l'adresse du cerveau (`https://192.168.1.20` par exemple, et les autres noms du certificat) ;
- la première chose à faire : `https://<adresse>/creer` crée l'entreprise et son premier compte admin ;
- le certificat racine exporté dans `deploy/local/ca.crt`, son empreinte SHA-256, et la commande qui l'installe pour le
  navigateur de cette machine (les postes des employés, eux, n'ont rien à faire : voir plus bas).

## Ce qui tourne

| Conteneur | Rôle |
|---|---|
| `postgres` | Postgres 16, données dans le volume Docker `brain-postgres`. Le schéma est appliqué au démarrage du cerveau (`npm run db:migrate`, chaque migration une seule fois). |
| `brain` | Le dashboard Next.js, son API et le client `brain.mjs` servi sur `/brain.mjs`, construits depuis ce dépôt (`Dockerfile`). |
| `caddy` | HTTPS devant le cerveau. Par défaut, une autorité privée créée par Caddy signe un certificat pour toutes les adresses de `BRAIN_HOSTS` ; le certificat racine est servi sur `/ca.crt`. |

Fichiers : `compose.yaml` (les trois services), `Dockerfile`, `deploy/local/Caddyfile`, `deploy/local/entrypoint.sh`
(migrations puis démarrage), `deploy/local/brain-local.sh` (le script de pilotage), `.env` à la racine (écrit par `up`,
modèle dans `deploy/local/env.example`).

## Brancher les postes

Le parcours est le même que dans le cloud : `/admin` → « Inviter quelqu'un » → un prompt d'installation que l'employé
colle dans Claude Code. Une seule chose change, parce que le cerveau est signé par une autorité que les postes ne
connaissent pas encore : la commande unique du prompt commence par récupérer le certificat (`/ca.crt`) et **vérifie son
empreinte SHA-256, épinglée dans le prompt** (le serveur la calcule depuis `BRAIN_CA_FILE`). Elle ne continue que si
l'empreinte correspond ; `install.sh` télécharge ensuite `brain.mjs` avec ce certificat, et `brain setup --ca` :

- l'enregistre dans `~/.company-brain/config.json` : la synchro, le MCP et les hooks lui font confiance, en plus des
  certificats publics (rien d'autre n'est modifié sur le poste) ;
- l'installe pour les navigateurs du poste (trousseau de session sur macOS, magasin utilisateur sur Windows, base NSS
  pour Chrome sous Linux), une fois par certificat ; Firefox a son propre magasin (Paramètres → Certificats → Importer).

Sous Windows, la commande du prompt (PowerShell) fait la même chose : certificat récupéré, empreinte vérifiée (code 9 si
elle diffère), ajout au magasin de l'utilisateur (Windows demande une confirmation), puis `install.ps1 --ca`.

Le message d'équipe (« rejoindre sur demande ») fait la même chose. Exemple complet du prompt : [install/PROMPT.md](../install/PROMPT.md#cerveau-auto-hébergé-https-sur-le-réseau-local).

Le jour où l'autorité change (machine réinstallée, passage à vos propres certificats), chaque poste relance
`~/.company-brain/brain setup --ca <nouveau certificat>`, ou se réinstalle avec un nouveau prompt.

## HTTPS : les choix possibles

| Option | Quand | Comment |
|---|---|---|
| **Autorité privée de Caddy** (défaut, `BRAIN_TLS=internal`) | Réseau local, pas de nom de domaine | Rien à faire. Le certificat couvre `BRAIN_HOSTS` : `localhost`, les adresses IP de la machine et `<nom-machine>.local` (mDNS, reconnu par macOS, Windows 10+ et Linux avec Avahi). Les postes récupèrent et vérifient le certificat via le prompt. |
| **Vos certificats** (`BRAIN_TLS="/certs/cert.pem /certs/key.pem"`) | Votre informatique a déjà une autorité interne, ou un nom de domaine avec un vrai certificat | Placez `cert.pem` et `key.pem` dans `deploy/local/certs/` (ignoré par git), mettez le nom dans `BRAIN_HOSTS`, puis `up`. Si l'autorité est déjà reconnue par les postes, les prompts n'épinglent rien. |
| Employés à distance | Hors du réseau local | Un VPN d'entreprise, ou un réseau superposé type Tailscale (qui fournit aussi un nom et un certificat valides) : le cerveau reste chez vous. |

Un nom plutôt qu'une adresse IP : ajoutez-le à `BRAIN_HOSTS` (et `BRAIN_HOST`) dans `.env`, puis `up`. Caddy
réémet le certificat ; les postes déjà branchés gardent le même certificat racine, rien à refaire.

## Claude

Deux modes, cumulables :

- **Sur chaque poste** (déjà le cas dans le cloud) : `brain-sync` distille avec `claude -p`, donc l'abonnement Claude Code
  de l'employé ; aucune clé sur le serveur.
- **Sur la machine du cerveau** : `ANTHROPIC_API_KEY` dans `.env` sert aux fonctions du serveur (« Où en est la boîte »,
  onboarding). Les appels partent de cette machine vers l'API Anthropic ; sans clé, le serveur garde ses heuristiques.

## Exploitation

| Besoin | Commande |
|---|---|
| État, adresses | `sh deploy/local/brain-local.sh status` |
| Journaux | `sh deploy/local/brain-local.sh logs` |
| Sauvegarde | `sh deploy/local/brain-local.sh backup` → `deploy/local/backups/brain-<date>.sql.gz` (à copier ailleurs) |
| Restaurer | `gunzip -c <fichier> \| docker compose exec -T postgres psql -U brain brain` |
| Mettre à jour | `sh deploy/local/brain-local.sh update` (git pull, reconstruction, redémarrage ; les données restent) |
| Certificat racine | `sh deploy/local/brain-local.sh ca` (réexporte `deploy/local/ca.crt`, affiche l'empreinte) |
| Arrêter | `sh deploy/local/brain-local.sh down` (les volumes restent ; `docker compose down -v` efface tout) |
| Démo | `BRAIN_DEMO=1` dans `.env` puis `up` : l'entreprise fictive Fournil se charge au premier passage sur `/login` |

Les conteneurs redémarrent avec Docker (`restart: unless-stopped`) : si la machine redémarre, le cerveau revient seul.

## Dépannage

- **Port 80 ou 443 déjà pris** : un autre serveur web tourne (`lsof -i :443`). Arrêtez-le, ou changez les ports dans
  `compose.yaml` et mettez `BRAIN_HOST=<adresse>:<port>`.
- **Le prompt s'arrête à la vérification de l'empreinte** : le poste n'a pas reçu le certificat attendu. Soit l'adresse
  n'est pas la bonne (un autre service répond), soit l'autorité a changé depuis la génération du prompt (`ca` affiche
  l'empreinte actuelle ; régénérez le prompt depuis `/admin`). Ne jamais contourner cette vérification.
- **« Caddy n'a pas encore créé son autorité »** : le premier démarrage prend quelques secondes ; relancez `ca`.
- **Avertissement de sécurité dans votre navigateur** sur la machine du cerveau : installez le certificat racine avec la
  commande affichée par `ca` (ou acceptez l'exception, le temps de créer l'entreprise).
- **Postgres refuse la connexion au démarrage** : `logs` ; le cerveau attend que Postgres soit prêt (`healthcheck`), un
  mot de passe changé dans `.env` après la première création ne s'applique pas au volume existant (`docker compose down -v`
  pour repartir de zéro, en perdant les données).

## Ce qui change par rapport au cloud

| | Cloud (Vercel + Neon) | Machine de l'entreprise |
|---|---|---|
| Où sont les données distillées | Chez l'hébergeur (Neon, Francfort) | Dans un volume Docker sur votre machine |
| Adresse | `https://cerveau.example.com` | `https://<ip ou nom>.local`, réseau local (ou VPN) |
| Certificat | Public, automatique | Autorité privée de Caddy, épinglée dans les prompts ; ou le vôtre |
| Disponibilité | Toujours en ligne | Tant que la machine est allumée ; la synchro des postes réessaie toutes les 15 min |
| Mise à jour | Déploiement git | `brain-local.sh update` |
| Sauvegarde | Chez l'hébergeur | `brain-local.sh backup` |
| Coût | Offres gratuites | Un ordinateur allumé |

Le code est le même : deux stockages derrière une seule interface (`apps/web/lib/store`), une seule API, un seul client.
