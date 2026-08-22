#!/bin/sh

set -eu

cleanup() {
	docker compose down --remove-orphans
}

trap cleanup EXIT HUP INT TERM

docker compose up --build --detach chat-api dispatch-bridge
docker compose run --rm --no-deps smoke
