#!/usr/bin/env bash

load_deploy_config() {
  DEPLOY_CONFIG_PATH="${DEPLOY_CONFIG:-infra/deploy/prod.env}"
  if [[ -f "$DEPLOY_CONFIG_PATH" ]]; then
    local line key value

    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

      if [[ "$line" == export[[:space:]]* ]]; then
        line="${line#export }"
      fi

      if [[ "$line" != *=* ]]; then
        echo "Invalid line in $DEPLOY_CONFIG_PATH: expected KEY=value" >&2
        exit 1
      fi

      key="${line%%=*}"
      value="${line#*=}"
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"

      if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        echo "Invalid variable name in $DEPLOY_CONFIG_PATH: $key" >&2
        exit 1
      fi

      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi

      if [[ "${!key+x}" != x ]]; then
        printf -v "$key" '%s' "$value"
        export "$key"
      fi
    done <"$DEPLOY_CONFIG_PATH"
  fi
}
