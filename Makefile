.PHONY: up down reset logs test test-db test-db-stop

up:
	docker compose up --build

down:
	docker compose down

reset:
	docker compose down -v
	docker compose up --build

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
