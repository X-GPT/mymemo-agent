#!/usr/bin/env bash
# PROBE — launches one hand Sandbox from the probe image on the v2 no-NAT egress connector with
# the policy-less execution role, mints a 30-minute port-8080 token, and prints the env the
# runner scripts read. Usage: eval "$(./run-vm.sh)"   |   ./run-vm.sh terminate <microvmId>
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-mymemo}" AWS_REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="${AWS_ACCOUNT_ID:-637423444544}"
NAME="${PROBE_IMAGE_NAME:-mymemo-agent-probe-v3-hand}"
IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT}:microvm-image:${NAME}"
INGRESS="arn:aws:lambda:${AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS"
EGRESS="${MICROVM_EGRESS_CONNECTOR_ARN:-arn:aws:lambda:us-west-2:637423444544:network-connector:nc-bc9a0eba-048d-420d-9416-fb5a65f10ae0}"
ROLE="${MICROVM_EXECUTION_ROLE_ARN:-arn:aws:iam::637423444544:role/mymemo-agent-prod-microvm-execution}"
if [[ "${1:-}" == "terminate" ]]; then aws lambda-microvms terminate-microvm --microvm-identifier "$2" >&2; echo "terminated $2" >&2; exit 0; fi
if [[ "${1:-}" == "token" ]]; then aws lambda-microvms create-microvm-auth-token --microvm-identifier "$2" --expiration-in-minutes 30 --allowed-ports 'port=8080' --query 'authToken."X-aws-proxy-auth"' --output text; exit 0; fi
out="$(aws lambda-microvms run-microvm --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "$INGRESS" --egress-network-connectors "$EGRESS" \
  --execution-role-arn "$ROLE" --run-hook-payload '{"probe":"v3-hand"}' \
  --idle-policy maxIdleDurationSeconds=900,suspendedDurationSeconds=3600,autoResumeEnabled=true \
  --maximum-duration-in-seconds 3600 --output json)"
id="$(echo "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["microvmId"])')"
ep="$(echo "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["endpoint"])')"
echo "launched $id at $ep; waiting for RUNNING" >&2
for _ in $(seq 1 60); do s="$(aws lambda-microvms get-microvm --microvm-identifier "$id" --query state --output text 2>/dev/null || echo PENDING)"; [[ "$s" == RUNNING ]] && break; sleep 3; done
tok="$("$0" token "$id")"
echo "export MICROVM_ID=$id HAND_URL=https://$ep HAND_TOKEN=$tok HAND_PORT=8080"
