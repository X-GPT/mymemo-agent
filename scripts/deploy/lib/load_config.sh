#!/usr/bin/env bash

load_deploy_config() {
  local config="${DEPLOY_CONFIG:-infra/deploy/prod.env}"
  if [[ -f "$config" ]]; then
    # shellcheck disable=SC1090
    source "$config"
  fi
}
