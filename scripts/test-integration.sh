#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: ANTHROPIC_API_KEY is not set. Export it before running this script."
  exit 1
fi

CONTAINER=arbor-test-postgres
DB_URL="postgres://postgres:postgres@localhost:5433/arbor_test"

cleanup() {
  docker stop "$CONTAINER" 2>/dev/null || true
  docker rm   "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=arbor_test \
  -p 5433:5432 \
  postgres:16

echo "Waiting for postgres..."
until docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done

docker exec "$CONTAINER" psql -U postgres -d arbor_test -c "
  CREATE TABLE IF NOT EXISTS url_config (
    url         TEXT PRIMARY KEY,
    description TEXT        NOT NULL,
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    added_by    TEXT        NOT NULL,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS agent_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
"

DATABASE_URL="$DB_URL" \
AWS_REGION=us-east-1 \
SLACK_BOT_TOKEN=xoxb-not-real \
npm run test:integration
