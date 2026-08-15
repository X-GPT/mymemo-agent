#!/usr/bin/env bash
set -euo pipefail

repository="${GITHUB_REPOSITORY:-X-GPT/mymemo-agent}"
environment_names=("$@")
if [[ "${#environment_names[@]}" -eq 0 ]]; then
  environment_names=("production-agentcore-canary")
fi

for environment_name in "${environment_names[@]}"; do
  configuration="$(gh api "repos/${repository}/environments/${environment_name}")"
  reviewer_count="$(jq '[.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]?] | length' <<<"${configuration}")"
  if [[ "${reviewer_count}" -lt 1 ]]; then
    echo "${environment_name} must have at least one required reviewer." >&2
    exit 1
  fi

  echo "Verified ${environment_name} with ${reviewer_count} required reviewer(s)."
done
