#!/usr/bin/env bash
# PROBE — operator-run. Registers the probe hand image from ./image via the platform builder
# (zip → S3 → create-microvm-image), reusing the v2 build role and artifacts bucket.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-mymemo}" AWS_REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="${AWS_ACCOUNT_ID:-637423444544}"
NAME="${PROBE_IMAGE_NAME:-mymemo-agent-probe-v3-hand}"
BUCKET=mymemo-agent-prod-artifacts
BUILD_ROLE="arn:aws:iam::${ACCOUNT}:role/mymemo-agent-prod-microvm-image-build"
BASE="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"
ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT}:microvm-image:${NAME}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
(cd "$here/image" && zip -qr "$work/hand.zip" .)
key="microvm-images/probe-v3-hand-$(date +%s).zip"
aws s3 cp "$work/hand.zip" "s3://${BUCKET}/${key}"
args=(--region "$AWS_REGION" --code-artifact "uri=s3://${BUCKET}/${key}" --base-image-arn "$BASE" --build-role-arn "$BUILD_ROLE"
      --cpu-configurations architecture=ARM_64
      --hooks 'port=8080,microvmHooks={run=ENABLED,runTimeoutInSeconds=60,resume=ENABLED,suspend=ENABLED,suspendTimeoutInSeconds=60,terminate=ENABLED},microvmImageHooks={ready=ENABLED,readyTimeoutInSeconds=300}'
      --description "v3 hand probe (#708)")
if aws lambda-microvms get-microvm-image --image-identifier "$ARN" >/dev/null 2>&1; then
  aws lambda-microvms update-microvm-image --image-identifier "$ARN" "${args[@]}"
else
  aws lambda-microvms create-microvm-image --name "$NAME" "${args[@]}"
fi
echo "polling $ARN (logs: /aws/lambda-microvms/${NAME})"
for _ in $(seq 1 60); do
  s="$(aws lambda-microvms get-microvm-image --image-identifier "$ARN" --query state --output text 2>/dev/null || echo TRANSIENT)"
  case "$s" in CREATED|UPDATED) echo "image $s: $ARN"; exit 0;; CREATING|UPDATING|TRANSIENT) sleep 20;; *) echo "build ended $s" >&2; exit 1;; esac
done
