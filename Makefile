# NOS Brainer locally: `make dev` does everything (config, dependencies, Postgres, migrations, dashboard).
# Settings (ports, database, API keys): .env, copied from .env.example on the first run.

SHELL := /bin/sh
.DEFAULT_GOAL := dev

# .env is created if missing, then read again (make restarts itself once).
-include .env
.env:
	@cp .env.example .env
	@echo "→ .env created from .env.example (ports, database, API keys): edit it if needed."

BRAIN_PORT ?= 3000
POSTGRES_PORT ?= 5432
POSTGRES_USER ?= brain
POSTGRES_PASSWORD ?= brain
POSTGRES_DB ?= brain
# Database given in .env, otherwise the local Postgres.
EXTERNAL_DB := $(strip $(DATABASE_URL))
DB_URL := $(if $(EXTERNAL_DB),$(EXTERNAL_DB),postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@127.0.0.1:$(POSTGRES_PORT)/$(POSTGRES_DB))

# All the variables of .env are passed to the commands (API keys, time zone…), then those computed here.
export $(shell sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env 2>/dev/null)
export BRAIN_PORT POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

DB := DATABASE_URL="$(EXTERNAL_DB)" sh scripts/local-db.sh
RUN := DATABASE_URL="$(DB_URL)" PORT="$(BRAIN_PORT)"

.PHONY: help dev demo setup db db-stop db-status db-reset migrate seed simulate test stop check-node check-port

help: ## List of commands
	@echo "NOS Brainer locally:"
	@awk -F':.*## ' '/^[a-z-]+:.*## / { printf "  make %-10s %s\n", $$1, $$2 }' Makefile

dev: setup migrate check-port ## Run everything: config, dependencies, Postgres, migrations, dashboard (empty brain)
	@echo "→ http://localhost:$(BRAIN_PORT) opens in your browser as soon as the server is ready (first time: creating your company)."
	@sh scripts/open-when-ready.sh "http://localhost:$(BRAIN_PORT)" &
	@$(RUN) BRAIN_LANDING=0 npm run dev

demo: setup migrate check-port ## Like dev, with the Encore demo company (one-click sign-in)
	@echo "→ Demo: http://localhost:$(BRAIN_PORT)/demo opens in your browser as soon as the server is ready."
	@sh scripts/open-when-ready.sh "http://localhost:$(BRAIN_PORT)/demo" &
	@$(RUN) BRAIN_DEMO=1 BRAIN_LANDING=0 npm run dev

setup: check-node .env node_modules/.installed ## Config (.env) and npm dependencies

node_modules/.installed: package-lock.json
	@echo "→ Installing dependencies (npm install)…"
	@npm install --no-audit --no-fund
	@touch $@

check-node:
	@command -v node >/dev/null 2>&1 || { echo "Node.js not found. Install Node.js 22, for example without admin rights:"; echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 22"; exit 1; }
	@node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node.js $$(node -v) is too old: version 20 or later is needed (nvm install 22)."; exit 1; }

check-port:
	@node -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen($(BRAIN_PORT),()=>s.close())" || { echo "Port $(BRAIN_PORT) is already taken: pick another one with BRAIN_PORT in .env, then run again."; exit 1; }

db: .env ## Start Postgres (Docker, private Postgres, or nothing if DATABASE_URL is set)
	@$(DB) start

db-stop: ## Stop Postgres
	@$(DB) stop

db-status: ## Database status
	@$(DB) status

db-reset: ## Erase all the data of the local database (asks for confirmation)
	@printf "Erase all the data of the local Postgres? [y/N] "; read r; [ "$$r" = y ] || [ "$$r" = Y ] || { echo "Cancelled."; exit 1; }
	@$(DB) reset

migrate: setup db ## Apply the SQL migrations (each one only once)
	@$(RUN) npm run --silent db:migrate

seed: migrate ## Load Encore into the database (FORCE=1 to overwrite an existing brain)
	@$(RUN) npm run seed -- $(if $(FORCE),--force,)

simulate: ## Make fictional agents work (with make demo running in another terminal)
	@$(RUN) npm run simulate

test: setup ## Tests (typecheck and unit tests)
	@npm run typecheck && npm test

stop: db-stop ## Stop everything (the dashboard stops with Ctrl-C)
