#!/usr/bin/env bash

load_deploy_config() {
  DEPLOY_CONFIG_PATH="${DEPLOY_CONFIG:-infra/deploy/prod.env}"
  if [[ -f "$DEPLOY_CONFIG_PATH" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$DEPLOY_CONFIG_PATH"
    set +a
  fi
}
