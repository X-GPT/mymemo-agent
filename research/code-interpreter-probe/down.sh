#!/usr/bin/env bash
# #730 — delete everything up.sh created, reverse order. Safe to re-run (interpreter ENIs can linger
# up to 8 h and block subnet/SG deletion — re-run later if the last steps report DependencyViolation).
set -uo pipefail
cd "$(dirname "$0")"
export AWS_PROFILE="${AWS_PROFILE:-mymemo}" AWS_REGION=us-west-2 AWS_PAGER=""
P=mymemo-ci-probe; ENV=probe.env; [ -f "$ENV" ] && { set -a; . "./$ENV"; set +a; }
gone() { grep -v "^$1=" "$ENV" > "$ENV.tmp" || true; mv "$ENV.tmp" "$ENV"; echo "    deleted $1"; }
[ -n "${CI_ID:-}" ] && { aws bedrock-agentcore-control delete-code-interpreter --code-interpreter-id "$CI_ID" >/dev/null && gone CI_ID; gone CI_ARN; }
[ -n "${AP_ID:-}" ] && { aws s3files delete-access-point --access-point-id "$AP_ID" && gone AP_ID; gone AP_ARN; }
for v in MT_A MT_B; do id=${!v:-}; [ -n "$id" ] && aws s3files delete-mount-target --mount-target-id "$id" && gone "$v"; done
if [ -n "${FS_ID:-}" ]; then
  for i in $(seq 1 60); do n=$(aws s3files list-mount-targets --file-system-id "$FS_ID" --query 'length(mountTargets)' --output text 2>/dev/null || echo 0); [ "$n" = "0" ] && break; sleep 5; done
  aws s3files delete-file-system --file-system-id "$FS_ID" && gone FS_ID; gone FS_ARN
  for i in $(seq 1 60); do aws s3files get-file-system --file-system-id "$FS_ID" >/dev/null 2>&1 || break; sleep 5; done
fi
for r in $P-ci-exec:mount-workspace $P-s3files:bucket-sync; do role=${r%%:*}; pol=${r##*:}
  aws iam get-role --role-name "$role" >/dev/null 2>&1 && { aws iam delete-role-policy --role-name "$role" --policy-name "$pol"; aws iam delete-role --role-name "$role" && echo "    deleted role $role"; }; done
gone ROLE_CI_ARN; gone ROLE_FS_ARN
for i in $(seq 1 12); do ok=1
  [ -n "${SG_CI:-}" ] && { aws ec2 delete-security-group --group-id "$SG_CI" 2>/dev/null && gone SG_CI || ok=0; }
  [ -n "${SG_MT:-}" ] && { aws ec2 delete-security-group --group-id "$SG_MT" 2>/dev/null && gone SG_MT || ok=0; }
  for v in SUBNET_A SUBNET_B; do id=${!v:-}; [ -n "$id" ] && { aws ec2 delete-subnet --subnet-id "$id" 2>/dev/null && gone "$v" || ok=0; }; done
  [ -n "${RTB:-}" ] && { aws ec2 delete-route-table --route-table-id "$RTB" 2>/dev/null && gone RTB || ok=0; }
  set -a; . "./$ENV"; set +a; [ "$ok" = 1 ] && break; echo "    network still in use (ENIs draining) — retry $i/12 in 30 s"; sleep 30; done
if [ -n "${BUCKET:-}" ]; then
  aws s3api list-object-versions --bucket "$BUCKET" --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] }' --output json > /tmp/$P-versions.json
  [ "$(jq '.Objects|length' /tmp/$P-versions.json)" != "0" ] && aws s3api delete-objects --bucket "$BUCKET" --delete file:///tmp/$P-versions.json >/dev/null
  aws s3api delete-bucket --bucket "$BUCKET" && gone BUCKET
fi
echo "DOWN. remaining in probe.env (empty = clean):"; cat "$ENV"
