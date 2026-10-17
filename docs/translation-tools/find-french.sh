#!/usr/bin/env bash
# Prints the lines that still contain French, for each file or directory given (paths relative to the repo).
# A directory expands to its git-tracked files. NOS_FR_LOOSE=1 skips the accent check (regex character classes).
cd "$HOME/nos_brainers" || exit 1
WORDS='le|la|les|des|une|est|pour|dans|avec|sur|pas|qui|que|aucun|aucune|fait|faire|vous|nous|votre|vos|cette|ces|sont|ou|mais|donc|leur|leurs|tous|toutes|toute|deja|poste|postes|connaissance|connaissances|entreprise|entreprises|jeton|jetons|du|au|aux|ne|il|ils|elle|elles|mon|ma|mes|ton|ses|lui|eux|selon|chez|vers|puis|encore|aussi|alors|de|en|un|si|par|ce|cet|comme|quand|avant|apres|sous|entre|rien|jamais|toujours|ici|deux|trois|chaque|autre|autres|meme|peut|doit|faut|ont|sera|etre|avoir|lit|lire|fermer|annuler|supprimer|enregistrer|ajouter|retour|continuer|copier|ouvrir|valider|modifier|envoyer|inviter|choisir|rechercher|chercher|voir|afficher|masquer|charger|membre|membres|equipe|personne|personnes|demande|demandes|accepter|refuser|oui|non|nom|titre|lien|cerveau|zone de|mise|jour|jours|heure|heures|minutes? de|fichier|fichiers|dossier|tache|taches|outil|outils|reglages|connexion|deconnexion|zoomer|dezoomer|tourner|glisser|introuvable|invalide|indisponible|manquant|manquante|inconnu|inconnue|refuse|bienvenue|merci|bonjour|salut|desole|attention|erreur|echec|reussi|termine|mois|semaine|annee|hier|demain|aujourd|maintenant|plus tard|tard|fois|depuis|pendant|vide|pret|prete|nouveau|nouvelle|ancien|ancienne|premier|premiere|dernier|derniere|suivant|precedent|seulement|toujours|plutot|sinon|lorsque|sans doute|illisible|injoignable|manquants?|activer|tester|journaux|journal|planification|planifiee?s?|indices|faibles|vocabulaire|commande|commandes|certificat|serveur|reseau|branche|branches|synchro|distillee?s?|reunions?|lecture|ecriture|envoi|envoyee?s?|recu|recue|reponse|demarre|lancer|relance|relancez|relancer|verifie|verifiez|installe|installee?|desinstallation|cle|jeton|ignoree?s|ecartee?s?|masquee?s?|retiree?s?|ajoutee?s?|autorisation|autorisations|reglages|navigateur|attente|essai|essais|echoue|abandon|abandonnee?s?|panne|delai|depasse|sortie|entree|chemin|chemins|fenetre|fenetres|ligne|lignes|octets|identifiant|empreinte|enregistre|enregistree?|supprime|supprimee?|toucher|rien|tout|bien|bonne|vrai|faux|seule?|ceux|celles?|celui|dont|parce|lorsque|tant'
if [ -n "$NOS_FR_LOOSE" ]; then FR="\\b($WORDS)\\b"; else FR="[éèêàçùôîâœ«»ÉÈÀÇ]|\\b($WORDS)\\b"; fi
files=()
for a in "$@"; do
  if [ -d "$a" ]; then
    while IFS= read -r f; do files+=("$f"); done < <(git ls-files "$a" | grep -E '\.(ts|tsx|mjs|js|css|md|sh|ps1|sql|yml|yaml|json|example)$|Dockerfile|Caddyfile')
  else
    files+=("$a")
  fi
done
for f in "${files[@]}"; do
  hits=$(grep -n -i -P "$FR" "$f" 2>/dev/null)
  [ -n "$hits" ] && { echo "=== $f"; echo "$hits"; }
done
exit 0
