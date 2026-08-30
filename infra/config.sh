#!/usr/bin/env bash
# Shared configuration for the deployment scripts. Sourced, never executed.
#
# Every value here is either a decision recorded in
# myDocs/aws-deployment-shape-decision.md or an identifier discovered by a
# read-only API call. Nothing that varies per-run belongs in this file.

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-quan-cli}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-southeast-1}"

PROJECT="scheduler"
GITHUB_OWNER="quan0401"
GITHUB_REPO="unified-service-scheduler"

# x86_64, because the images are built by GitHub Actions on ubuntu-latest.
# Changing this to arm64 means changing the AMI parameter and the workflow's
# build platform together -- they are one decision, not two.
INSTANCE_TYPE="t3a.small"
INSTANCE_ARCH="amd64"
ROOT_VOLUME_GB=20

# Resolved at launch by EC2 itself, so the AMI is never pinned in git.
AMI_SSM_PARAM="/aws/service/canonical/ubuntu/server/24.04/stable/current/${INSTANCE_ARCH}/hvm/ebs-gp3/ami-id"

# CloudFront's origin-facing ranges. Region-specific id; AWS keeps the contents
# current. Weight 55 against a default 60-rule security group quota.
CF_PREFIX_LIST_ID="pl-31a34658"

# Managed CloudFront policies. Ids are global and documented.
CF_CACHE_OPTIMIZED="658327ea-f89d-4fab-a63d-7e88639e58f6"
CF_CACHE_DISABLED="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
CF_ORIGIN_ALL_VIEWER="216adef6-5c7f-47e4-b989-5492eafa07d3"

# Resource names. Used by both deploy.sh and teardown.sh; teardown deletes
# exactly what these name and nothing else.
ECR_API_REPO="${PROJECT}-api"
ECR_WEB_REPO="${PROJECT}-web"
GHA_ROLE_NAME="${PROJECT}-gha-ecr-push"
EC2_ROLE_NAME="${PROJECT}-ec2-role"
EC2_PROFILE_NAME="${PROJECT}-ec2-profile"
SG_NAME="${PROJECT}-origin-sg"
INSTANCE_NAME="${PROJECT}-host"
CF_COMMENT="${PROJECT} demo distribution"
OIDC_PROVIDER_URL="token.actions.githubusercontent.com"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
