#!/usr/bin/env bash
# #730 — create the scratch topology for the Code Interpreter + S3 Files probe. OPERATOR-RUN.
# Idempotent: every id lands in probe.env and is reused on re-run. Tear down with down.sh.
set -euo pipefail
cd "$(dirname "$0")"
export AWS_PROFILE="${AWS_PROFILE:-mymemo}" AWS_REGION=us-west-2 AWS_PAGER=""
P=mymemo-ci-probe
VPC=vpc-05772c7f2f628c024
ENV=probe.env; touch "$ENV"; set -a; . "./$ENV"; set +a
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
save() { grep -v "^$1=" "$ENV" > "$ENV.tmp" || true; echo "$1=$2" >> "$ENV.tmp"; mv "$ENV.tmp" "$ENV"; export "$1=$2"; echo "    $1=$2"; }
lower() { tr '[:upper:]' '[:lower:]'; }
wait_for() { # wait_for <label> <cmd...>  — polls until status is available/ready/active
  local label=$1; shift; local i s
  for i in $(seq 1 90); do
    s=$("$@" 2>/dev/null | lower || echo pending)
    case "$s" in available|ready|active) echo "    $label: $s"; return 0 ;; *fail*|*error*|*delet*) echo "    $label: $s" >&2; return 1 ;; esac
    sleep 5
  done; echo "    $label: timeout (last=$s)" >&2; return 1; }
echo "account=$ACCOUNT region=$AWS_REGION vpc=$VPC"

echo "[1/9] versioned bucket"
: "${BUCKET:=$P-$ACCOUNT}"; save BUCKET "$BUCKET"
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=$AWS_REGION >/dev/null
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "[2/9] S3 Files service role (sync role the file system assumes)"
ROLE_FS=$P-s3files
if ! aws iam get-role --role-name "$ROLE_FS" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_FS" --assume-role-policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"elasticfilesystem.amazonaws.com"},"Action":"sts:AssumeRole",
 "Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"},"ArnLike":{"aws:SourceArn":"arn:aws:s3files:$AWS_REGION:$ACCOUNT:file-system/*"}}}]}
JSON
)" >/dev/null; fi
aws iam put-role-policy --role-name "$ROLE_FS" --policy-name bucket-sync --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"Bucket","Effect":"Allow","Action":["s3:ListBucket","s3:ListBucketVersions"],"Resource":"arn:aws:s3:::$BUCKET","Condition":{"StringEquals":{"aws:ResourceAccount":"$ACCOUNT"}}},
 {"Sid":"Objects","Effect":"Allow","Action":["s3:AbortMultipartUpload","s3:DeleteObject*","s3:GetObject*","s3:List*","s3:PutObject*"],"Resource":"arn:aws:s3:::$BUCKET/*","Condition":{"StringEquals":{"aws:ResourceAccount":"$ACCOUNT"}}},
 {"Sid":"EventBridgeManage","Effect":"Allow","Action":["events:DeleteRule","events:DisableRule","events:EnableRule","events:PutRule","events:PutTargets","events:RemoveTargets"],"Resource":"arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*","Condition":{"StringEquals":{"events:ManagedBy":"elasticfilesystem.amazonaws.com"}}},
 {"Sid":"EventBridgeRead","Effect":"Allow","Action":["events:DescribeRule","events:ListRuleNamesByTarget","events:ListRules","events:ListTargetsByRule"],"Resource":"arn:aws:events:*:*:rule/*"}]}
JSON
)"; sleep 10
save ROLE_FS_ARN "arn:aws:iam::$ACCOUNT:role/$ROLE_FS"

echo "[3/9] S3 Files file system on the bucket (Q1: does S3 Files exist here?)"
if [ -z "${FS_ID:-}" ]; then
  sleep 10 # role propagation
  out=$(aws s3files create-file-system --bucket "arn:aws:s3:::$BUCKET" --role-arn "$ROLE_FS_ARN" --accept-bucket-warning --client-token "$P-fs" --tags key=Name,value=$P)
  save FS_ID "$(echo "$out" | jq -r .fileSystemId)"; save FS_ARN "$(echo "$out" | jq -r .fileSystemArn)"
fi
wait_for "file system $FS_ID" aws s3files get-file-system --file-system-id "$FS_ID" --query status --output text

echo "[4/9] two NO-ROUTE subnets (usw2-az2 / usw2-az1) + a route table with only the local route"
if [ -z "${RTB:-}" ]; then save RTB "$(aws ec2 create-route-table --vpc-id $VPC --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=$P}]" --query RouteTable.RouteTableId --output text)"; fi
mk_subnet() { aws ec2 create-subnet --vpc-id $VPC --cidr-block "$2" --availability-zone "$3" --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$P-$1}]" --query Subnet.SubnetId --output text; }
[ -n "${SUBNET_A:-}" ] || save SUBNET_A "$(mk_subnet a 172.31.90.0/24 us-west-2a)"
[ -n "${SUBNET_B:-}" ] || save SUBNET_B "$(mk_subnet b 172.31.91.0/24 us-west-2b)"
for s in "$SUBNET_A" "$SUBNET_B"; do aws ec2 associate-route-table --route-table-id "$RTB" --subnet-id "$s" >/dev/null 2>&1 || true; done
aws ec2 describe-subnets --subnet-ids "$SUBNET_A" "$SUBNET_B" --query 'Subnets[].[SubnetId,AvailabilityZoneId,CidrBlock]' --output text | sed 's/^/    /'

echo "[5/9] security groups: mount-target SG (ingress 2049 from interpreter SG); interpreter SG (egress 2049 to MT SG ONLY)"
mk_sg() { aws ec2 create-security-group --vpc-id $VPC --group-name "$P-$1" --description "$P $1" --query GroupId --output text; }
[ -n "${SG_MT:-}" ] || save SG_MT "$(mk_sg mt)"
[ -n "${SG_CI:-}" ] || { save SG_CI "$(mk_sg ci)"; aws ec2 revoke-security-group-egress --group-id "$SG_CI" --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null; }
aws ec2 authorize-security-group-ingress --group-id "$SG_MT" --protocol tcp --port 2049 --source-group "$SG_CI" >/dev/null 2>&1 || true
aws ec2 authorize-security-group-egress  --group-id "$SG_CI" --protocol tcp --port 2049 --source-group "$SG_MT" >/dev/null 2>&1 || true

echo "[6/9] mount targets, one per AZ (Q1: do mount targets land in usw2-az1/az2?)"
mk_mt() { aws s3files create-mount-target --file-system-id "$FS_ID" --subnet-id "$1" --security-groups "$SG_MT" --query mountTargetId --output text; }
[ -n "${MT_A:-}" ] || save MT_A "$(mk_mt "$SUBNET_A")"
[ -n "${MT_B:-}" ] || save MT_B "$(mk_mt "$SUBNET_B")"
for mt in "$MT_A" "$MT_B"; do wait_for "mount target $mt" aws s3files get-mount-target --mount-target-id "$mt" --query status --output text; done
aws s3files list-mount-targets --file-system-id "$FS_ID" --query 'mountTargets[].[mountTargetId,availabilityZoneId,subnetId,status]' --output text | sed 's/^/    /'

echo "[7/9] access point = one Conversation's workspace: root /conv-probe, POSIX 1000:1000"
if [ -z "${AP_ARN:-}" ]; then
  out=$(aws s3files create-access-point --cli-input-json "{\"fileSystemId\":\"$FS_ID\",\"clientToken\":\"$P-ap\",\"posixUser\":{\"uid\":1000,\"gid\":1000},\"rootDirectory\":{\"path\":\"/conv-probe\",\"creationPermissions\":{\"ownerUid\":1000,\"ownerGid\":1000,\"permissions\":\"0755\"}},\"tags\":[{\"key\":\"Name\",\"value\":\"$P\"}]}")
  save AP_ID "$(echo "$out" | jq -r .accessPointId)"; save AP_ARN "$(echo "$out" | jq -r .accessPointArn)"
fi
wait_for "access point $AP_ID" aws s3files get-access-point --access-point-id "$AP_ID" --query status --output text

echo "[8/9] interpreter execution role (mount permissions only)"
ROLE_CI=$P-ci-exec
if ! aws iam get-role --role-name "$ROLE_CI" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_CI" --assume-role-policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}]}
JSON
)" >/dev/null; sleep 10; fi
aws iam put-role-policy --role-name "$ROLE_CI" --policy-name mount-workspace --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3files:ClientMount","s3files:ClientWrite"],"Resource":"$FS_ARN","Condition":{"ArnEquals":{"s3files:AccessPointArn":"$AP_ARN"}}},{"Effect":"Allow","Action":["s3files:GetAccessPoint","s3files:GetFileSystem","s3files:ListMountTargets","s3files:GetMountTarget","s3files:ListAccessPoints"],"Resource":["$FS_ARN","$AP_ARN","$FS_ARN/*"]},{"Effect":"Allow","Action":["ec2:DescribeSubnets","ec2:DescribeSecurityGroups","ec2:DescribeNetworkInterfaces","ec2:DescribeVpcs"],"Resource":"*"}]}
JSON
)"; sleep 10
save ROLE_CI_ARN "arn:aws:iam::$ACCOUNT:role/$ROLE_CI"

echo "[9/9] custom Code Interpreter, VPC mode, no-route subnets, S3 Files mount at /mnt/ws"
if [ -z "${CI_ID:-}" ]; then
  out=$(aws bedrock-agentcore-control create-code-interpreter --name mymemo_ci_probe --description "#730 probe" \
    --execution-role-arn "$ROLE_CI_ARN" --client-token "$P-ci-$(uuidgen | tr -d -)" \
    --network-configuration "{\"networkMode\":\"VPC\",\"vpcConfig\":{\"subnets\":[\"$SUBNET_A\",\"$SUBNET_B\"],\"securityGroups\":[\"$SG_CI\"]}}" \
    --filesystem-configurations "[{\"s3FilesConfiguration\":{\"accessPointArn\":\"$AP_ARN\",\"fileSystemArn\":\"$FS_ARN\",\"mountPath\":\"/mnt/ws\"}}]")
  save CI_ID "$(echo "$out" | jq -r .codeInterpreterId)"; save CI_ARN "$(echo "$out" | jq -r .codeInterpreterArn)"
fi
wait_for "code interpreter $CI_ID" aws bedrock-agentcore-control get-code-interpreter --code-interpreter-id "$CI_ID" --query status --output text
echo; echo "UP. probe.env:"; cat "$ENV"
