.PHONY: up up-ai down reset demo logs test test-db test-db-stop

up:
	docker compose up --build

## Same as up, plus the AI assistant with a local model (first run downloads ~2 GB)
up-ai:
	docker compose --profile ai up -d ollama
	docker compose exec ollama ollama pull $${OLLAMA_MODEL:-qwen2.5:3b}
	ASSISTANT_ENABLED=true docker compose --profile ai up --build

down:
	docker compose --profile ai down

reset:
	docker compose down -v
	docker compose up --build

## Deterministic demo: wipes the local demo volumes, seeds, then runs one scripted business day (synthetic data)
demo:
	docker compose down -v
	docker compose up -d --build --wait
	./scripts/demo-scenario.sh

logs:
	docker compose logs -f backend

# Unit + e2e tests in containers, with a disposable database and object store.
test:
	docker compose --profile test run --rm --build backend-test
	docker compose --profile test down -v

# Disposable Postgres on port 55433 for running `npm run test:e2e` from backend/ without Docker for Node.
test-db:
	docker run -d --rm --name yamesi-test-db -e POSTGRES_DB=yamesi_test -e POSTGRES_USER=yamesi \
		-e POSTGRES_PASSWORD=yamesi_test -p 55433:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine

test-db-stop:
	docker stop yamesi-test-db
