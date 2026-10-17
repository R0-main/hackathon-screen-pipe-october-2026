# NOS Brainer en local : `make dev` fait tout (config, dépendances, Postgres, migrations, dashboard).
# Réglages (ports, base, clés API) : .env, copié depuis .env.example au premier lancement.

SHELL := /bin/sh
.DEFAULT_GOAL := dev

# .env est créé s'il manque, puis relu (make se relance tout seul une fois).
-include .env
.env:
	@cp .env.example .env
	@echo "→ .env créé depuis .env.example (ports, base, clés API) : modifie-le si besoin."

BRAIN_PORT ?= 3000
POSTGRES_PORT ?= 5432
POSTGRES_USER ?= brain
POSTGRES_PASSWORD ?= brain
POSTGRES_DB ?= brain
# Base fournie dans .env, sinon le Postgres local.
EXTERNAL_DB := $(strip $(DATABASE_URL))
DB_URL := $(if $(EXTERNAL_DB),$(EXTERNAL_DB),postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@127.0.0.1:$(POSTGRES_PORT)/$(POSTGRES_DB))

# Toutes les variables de .env passent aux commandes (clés API, fuseau…), puis celles calculées ici.
export $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env 2>/dev/null)
export BRAIN_PORT POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

DB := DATABASE_URL="$(EXTERNAL_DB)" sh scripts/local-db.sh
RUN := DATABASE_URL="$(DB_URL)" PORT="$(BRAIN_PORT)"

.PHONY: help dev demo setup db db-stop db-status db-reset migrate seed simulate test stop check-node check-port

help: ## Liste des commandes
	@echo "NOS Brainer en local :"
	@awk -F':.*## ' '/^[a-z-]+:.*## / { printf "  make %-10s %s\n", $$1, $$2 }' Makefile

dev: setup migrate check-port ## Tout lancer : config, dépendances, Postgres, migrations, dashboard (cerveau vide)
	@echo "→ Dashboard : http://localhost:$(BRAIN_PORT)  (première fois : /creer pour créer ton entreprise)"
	@$(RUN) npm run dev

demo: setup migrate check-port ## Comme dev, avec l'entreprise de démonstration Butine (connexion en un clic)
	@echo "→ Démo : http://localhost:$(BRAIN_PORT)/demo"
	@$(RUN) BRAIN_DEMO=1 npm run dev

setup: check-node .env node_modules/.installed ## Config (.env) et dépendances npm

node_modules/.installed: package-lock.json
	@echo "→ Installation des dépendances (npm install)…"
	@npm install --no-audit --no-fund
	@touch $@

check-node:
	@command -v node >/dev/null 2>&1 || { echo "Node.js est introuvable. Installe Node.js 22, par exemple sans droits admin :"; echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 22"; exit 1; }
	@node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node.js $$(node -v) est trop ancien : il faut la version 20 ou plus (nvm install 22)."; exit 1; }

check-port:
	@node -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen($(BRAIN_PORT),()=>s.close())" || { echo "Le port $(BRAIN_PORT) est déjà pris : choisis-en un autre avec BRAIN_PORT dans .env, puis relance."; exit 1; }

db: .env ## Démarrer Postgres (Docker, Postgres privé, ou rien si DATABASE_URL est renseignée)
	@$(DB) start

db-stop: ## Arrêter Postgres
	@$(DB) stop

db-status: ## État de la base
	@$(DB) status

db-reset: ## Effacer toutes les données de la base locale (demande confirmation)
	@printf "Effacer toutes les données du Postgres local ? [o/N] "; read r; [ "$$r" = o ] || [ "$$r" = O ] || { echo "Annulé."; exit 1; }
	@$(DB) reset

migrate: setup db ## Appliquer les migrations SQL (chacune une seule fois)
	@$(RUN) npm run --silent db:migrate

seed: migrate ## Charger Butine dans la base (FORCE=1 pour écraser un cerveau existant)
	@$(RUN) npm run seed -- $(if $(FORCE),--force,)

simulate: ## Faire travailler des agents fictifs (avec make demo lancé dans un autre terminal)
	@$(RUN) npm run simulate

test: setup ## Tests (typecheck et tests unitaires)
	@npm run typecheck && npm test

stop: db-stop ## Tout arrêter (le dashboard s'arrête avec Ctrl-C)
