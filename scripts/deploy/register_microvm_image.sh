#!/usr/bin/env bash
# Register the production MicroVM image (ticket #661, spec #654).
#
# Zips infra/microvm-image, uploads it to the artifacts bucket, then creates
# (first run) or updates (every later run) the MicroVM image and polls until
# the build lands. Run on main by .github/workflows/microvm-image.yml with the
# deploy role; hand-runnable with an operator profile:
#   AWS_PROFILE=mymemo scripts/deploy/register_microvm_image.sh
#
# Platform corrections baked in (verified live on the #646 probe):
#  - get-microvm-image needs the full image ARN, not the bare name;
#  - build logs land under /aws/lambda-microvms/<name> (hyphenated);
#  - run/create can throw a transient 502 — retried once.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "${script_dir}/lib/load_config.sh"
load_deploy_config
: "${AWS_REGION:?AWS_REGION is required}"
: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"

image_name="${MICROVM_IMAGE_NAME:-mymemo-agent-prod-microvm}"
bucket="${MICROVM_ARTIFACT_BUCKET:-mymemo-agent-prod-artifacts}"
build_role_arn="arn:aws:iam::${AWS_ACCOUNT_ID}:role/mymemo-agent-prod-microvm-image-build"
base_image_arn="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"
image_arn="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:microvm-image:${image_name}"
build_log_group="/aws/lambda-microvms/${image_name}"

sha="$(git -C "${repo_root}" rev-parse --short HEAD)"
key="microvm-images/app-${sha}.zip"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
(cd "${repo_root}/infra/microvm-image" && zip -q "${workdir}/app.zip" Dockerfile managed-settings.json server.mjs smoke.sh)
aws s3 cp --region "${AWS_REGION}" "${workdir}/app.zip" "s3://${bucket}/${key}"

# Both create and update take the same build inputs; update refuses to build
# without --base-image-arn and --build-role-arn even when only the code
# artifact changed (ValidationException).
build_args=(
	--region "${AWS_REGION}"
	--code-artifact "uri=s3://${bucket}/${key}"
	--base-image-arn "${base_image_arn}"
	--build-role-arn "${build_role_arn}"
	--cpu-configurations architecture=ARM_64
	--hooks 'port=8080,microvmHooks={run=ENABLED,resume=ENABLED,suspend=ENABLED,terminate=ENABLED},microvmImageHooks={ready=ENABLED,readyTimeoutInSeconds=300}'
	--description "mymemo-agent ${sha} (#661 image skeleton)"
)

register() {
	if aws lambda-microvms get-microvm-image --region "${AWS_REGION}" \
		--image-identifier "${image_arn}" >/dev/null 2>&1; then
		echo "Updating ${image_name} from s3://${bucket}/${key}"
		aws lambda-microvms update-microvm-image --image-identifier "${image_arn}" "${build_args[@]}"
	else
		echo "Creating ${image_name} from s3://${bucket}/${key}"
		aws lambda-microvms create-microvm-image --name "${image_name}" "${build_args[@]}"
	fi
}

if ! register; then
	echo "Registration failed once (transient 502s are a known platform behavior); retrying." >&2
	sleep 5
	register
fi

echo "Polling ${image_arn} until the build lands (logs: ${build_log_group})"
for _ in $(seq 1 60); do
	state="$(aws lambda-microvms get-microvm-image --region "${AWS_REGION}" \
		--image-identifier "${image_arn}" --query state --output text)"
	case "${state}" in
	CREATED | UPDATED)
		echo "MicroVM image ${image_name} is ${state}."
		exit 0
		;;
	CREATING | UPDATING)
		sleep 20
		;;
	*)
		echo "MicroVM image build ended in ${state}. Check CloudWatch log group ${build_log_group}." >&2
		exit 1
		;;
	esac
done

echo "Timed out waiting for ${image_name} to finish building. Check ${build_log_group}." >&2
exit 1
