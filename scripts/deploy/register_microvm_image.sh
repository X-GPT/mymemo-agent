#!/usr/bin/env bash
# Register the production MicroVM image (tickets #661/#666, spec #654).
#
# Stages the build context (scripts/deploy/stage_microvm_image_context.sh:
# the image directory plus the pruned In-VM server workspace), zips it,
# uploads it to the artifacts bucket, then creates (first run) or updates
# (every later run) the MicroVM image and polls until the build lands. Run on
# main by .github/workflows/microvm-image.yml with the deploy role;
# hand-runnable with an operator profile:
#   AWS_PROFILE=mymemo scripts/deploy/register_microvm_image.sh
# MICROVM_IMAGE_NAME overrides the image name for a scratch pre-merge
# verification build (delete it with delete-microvm-image afterwards).
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
bucket="mymemo-agent-prod-artifacts"
build_role_arn="arn:aws:iam::${AWS_ACCOUNT_ID}:role/mymemo-agent-prod-microvm-image-build"
base_image_arn="arn:aws:lambda:${AWS_REGION}:aws:microvm-image:al2023-1"
image_arn="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:microvm-image:${image_name}"
build_log_group="/aws/lambda-microvms/${image_name}"

sha="$(git -C "${repo_root}" rev-parse --short HEAD)"
key="microvm-images/app-${sha}.zip"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
"${script_dir}/stage_microvm_image_context.sh" "${workdir}/context"
(cd "${workdir}/context" && zip -qr "${workdir}/app.zip" .)
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
	# runTimeoutInSeconds=60 (the platform max): the default is a few seconds,
	# and the /run hook deliberately configures before answering 200 — CLI
	# exec-verify + boot sweep through a cold connector ENI. Proven necessary
	# live: an unset timeout terminated the VM ~3s after launch (#666).
	--hooks 'port=8080,microvmHooks={run=ENABLED,runTimeoutInSeconds=60,resume=ENABLED,suspend=ENABLED,terminate=ENABLED},microvmImageHooks={ready=ENABLED,readyTimeoutInSeconds=300}'
	--description "mymemo-agent ${sha} (In-VM server)"
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
	# The platform's transient 502s hit reads too (bit the poll live on #666
	# after a successful update) — treat a failed poll as "still building".
	state="$(aws lambda-microvms get-microvm-image --region "${AWS_REGION}" \
		--image-identifier "${image_arn}" --query state --output text 2>/dev/null || echo TRANSIENT)"
	case "${state}" in
	CREATED | UPDATED)
		echo "MicroVM image ${image_name} is ${state}."
		exit 0
		;;
	CREATING | UPDATING | TRANSIENT)
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
