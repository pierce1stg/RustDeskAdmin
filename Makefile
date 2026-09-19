# Makefile for RustDesk Admin
#
# The canonical deploy path is ./setup.sh (idempotent bootstrap).
# This Makefile only wraps conveniences that actually exist in this repo.

.PHONY: help check dev dev-detached build build-backend build-frontend \
        logs logs-backend logs-frontend logs-db \
        shell-backend shell-frontend shell-db \
        test env-check clean prune

.DEFAULT_GOAL := help

help:
	@echo "RustDesk Admin - available commands:"
	@echo ""
	@echo "Development:"
	@echo "  make dev              - start stack (+rebuild)"
	@echo "  make dev-detached     - start stack in background"
	@echo ""
	@echo "Building:"
	@echo "  make build            - build all custom images"
	@echo "  make build-backend    - build backend image only"
	@echo "  make build-frontend   - build frontend image only"
	@echo ""
	@echo "Logs:"
	@echo "  make logs             - follow all logs"
	@echo "  make logs-backend     - backend logs only"
	@echo "  make logs-frontend    - frontend logs only"
	@echo "  make logs-db          - postgres logs only"
	@echo ""
	@echo "Shell access:"
	@echo "  make shell-backend    - shell into backend container"
	@echo "  make shell-frontend   - shell into frontend container"
	@echo "  make shell-db         - psql into postgres"
	@echo ""
	@echo "Other:"
	@echo "  make check           - run bash-based git anonymity guard (no real data in git)"
	@echo "  make test            - run Go tests (backend container)"
	@echo "  make env-check       - verify .env exists"
	@echo "  make clean            - down + remove orphan containers (KEEPS data/)"
	@echo "  make prune            - docker system prune (safe variant, no -a -v)"

# Development
dev:
	docker compose up --build

dev-detached:
	docker compose up --build -d

# Building
build:
	docker compose build

build-backend:
	docker compose build backend

build-frontend:
	docker compose build frontend

# Logs
logs:
	docker compose logs -f

logs-backend:
	docker compose logs -f backend

logs-frontend:
	docker compose logs -f frontend

logs-db:
	docker compose logs -f postgres

# Shell access
shell-backend:
	docker compose exec backend sh

shell-frontend:
	docker compose exec frontend sh

shell-db:
	docker compose exec postgres psql -U rustdesk -d rustdesk_admin

# Testing
check:
	@if [ -f scripts/check-anonymity.sh ]; then ./scripts/check-anonymity.sh; else echo "anonymity guard is local-only (not committed); skipping"; fi

test:
	docker compose exec backend go test ./...

# Environment
env-check:
	@test -f .env || (echo "Missing .env file. Copy .env.example to .env" && exit 1)

# Cleanup (data/ and status/ are preserved)
clean:
	docker compose down --remove-orphans
	docker image prune -f

prune:
	docker system prune -f