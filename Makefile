.PHONY: up up-ai down reset demo logs detect test test-db test-db-stop

## Creates .env from .env.example with a fresh random value for every "replace-with-..." secret
.env:
	@while IFS= read -r line; do \
		case "$$line" in *=replace-with-*) echo "$${line%%=*}=$$(openssl rand -hex 32)" ;; *) echo "$$line" ;; esac; \
	done < .env.example > .env
	@echo "Created .env with random secrets"

up: .env
	docker compose up --build

## Same as up, plus the AI assistant with a local model (first run downloads ~2 GB)
up-ai: .env
	docker compose --profile ai up -d ollama
	docker compose exec ollama ollama pull $${OLLAMA_MODEL:-qwen2.5:3b}
	ASSISTANT_ENABLED=true docker compose --profile ai up --build

down:
	docker compose --profile ai down

reset: .env
	docker compose down -v
	docker compose up --build

## Deterministic demo: wipes the local demo volumes, seeds, then runs one scripted business day (synthetic data)
demo: .env
	docker compose down -v
	docker compose up -d --build --wait
	./scripts/demo-scenario.sh

logs:
	docker compose logs -f backend

## Runs the detection rules over the API's security events and prints the alerts (docs/SECURITY_DETECTION.md)
detect:
	docker compose logs --no-log-prefix backend | docker compose exec -T backend node dist/security/detect-cli.js

# Unit + e2e tests in containers, with a disposable database and object store. The demo stack and its data are left alone.
test: .env
	docker compose --profile test run --rm --build backend-test
	docker compose --profile test rm --stop --force --volumes postgres-test storage-test backend-test

# Disposable Postgres on port 55433 for running `npm run test:e2e` from backend/ without Docker for Node.
test-db:
	docker run -d --rm --name yamesi-test-db -e POSTGRES_DB=yamesi_test -e POSTGRES_USER=yamesi \
		-e POSTGRES_PASSWORD=yamesi_test -p 55433:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine

test-db-stop:
	docker stop yamesi-test-db
