#!/usr/bin/env bash
# PROTOTYPE — throwaway. Brings up the scratch Postgres the ownership prototype
# runs against: a standalone container (compose's postgres is not port-mapped),
# the real @mymemo/agent-db migrations, then the ADR-0015 schema delta.
set -euo pipefail

NAME=mymemo-prototype-ownership-wipe-me
PORT=${PROTO_PG_PORT:-55432}
URL="postgresql://proto:proto@127.0.0.1:${PORT}/prototype_ownership_wipe_me"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [ "${1:-up}" = "down" ]; then
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	echo "removed $NAME"
	exit 0
fi

if ! docker inspect "$NAME" >/dev/null 2>&1; then
	docker run -d --name "$NAME" \
		-e POSTGRES_USER=proto -e POSTGRES_PASSWORD=proto \
		-e POSTGRES_DB=prototype_ownership_wipe_me \
		-p "${PORT}:5432" postgres:16 >/dev/null
	echo "started $NAME on :${PORT}"
fi
docker start "$NAME" >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
	if docker exec "$NAME" pg_isready -U proto -d prototype_ownership_wipe_me >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

AGENT_DATABASE_URL="$URL" DB_SSL=disable \
	bun run --cwd "$ROOT/apps/chat-api" db:migrate

echo
echo "ready: $URL"
echo "  bun run --cwd packages/agent-db proto:tui"
