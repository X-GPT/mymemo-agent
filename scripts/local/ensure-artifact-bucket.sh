#!/bin/sh

set -eu

bucket="${ARTIFACT_BUCKET:?ARTIFACT_BUCKET is required}"
region="${AWS_REGION:?AWS_REGION is required}"
script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"

if ! aws s3api head-bucket --bucket "$bucket" --no-cli-pager >/dev/null 2>&1; then
	if [ "$region" = "us-east-1" ]; then
		aws s3api create-bucket \
			--bucket "$bucket" \
			--region "$region" \
			--no-cli-pager
	else
		aws s3api create-bucket \
			--bucket "$bucket" \
			--region "$region" \
			--create-bucket-configuration "LocationConstraint=$region" \
			--no-cli-pager
	fi
fi

aws s3api put-public-access-block \
	--bucket "$bucket" \
	--public-access-block-configuration \
		"BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
	--no-cli-pager

aws s3api put-bucket-ownership-controls \
	--bucket "$bucket" \
	--ownership-controls "Rules=[{ObjectOwnership=BucketOwnerEnforced}]" \
	--no-cli-pager

aws s3api put-bucket-lifecycle-configuration \
	--bucket "$bucket" \
	--lifecycle-configuration "file://$script_dir/artifact-bucket-lifecycle.json" \
	--no-cli-pager
