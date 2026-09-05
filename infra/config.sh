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
#
# t3.small rather than the marginally cheaper t3a.small, which this account
# cannot launch at all:
#
#   InvalidParameterCombination: The specified instance type is not eligible
#   for Free Tier.
#
# The account is on the AWS Free Plan, which restricts it to free-tier-eligible
# types. In ap-southeast-1 those are t3.micro, t3.small, t4g.micro, t4g.small,
# c7i-flex.large, and m7i-flex.large -- t3a is not among them. t3.small is the
# same 2 vCPU / 2 GiB as t3a.small and consumes identical linux/amd64 images.
INSTANCE_TYPE="t3.small"
INSTANCE_ARCH="amd64"
ROOT_VOLUME_GB=20

# Resolved at launch by EC2 itself, so the AMI is never pinned in git.
AMI_SSM_PARAM="/aws/service/canonical/ubuntu/server/24.04/stable/current/${INSTANCE_ARCH}/hvm/ebs-gp3/ami-id"

# TLS. The instance terminates it with a Let's Encrypt certificate.
#
# DOMAINS lists every name that certificate must cover, primary first. The
# primary also becomes APP_URL and CORS_ORIGIN. All of them must already
# resolve to the Elastic IP before deploy.sh runs: http-01 validation fetches
# http://<name>/.well-known/acme-challenge/ for each, and a single name that
# does not point here fails the whole issuance, not just its own entry.
#
# One certificate covering every name, not one per name. nginx has a single
# ssl_certificate path, so only one certificate is ever served no matter how
# many certbot lineages exist -- issuing a second one produces a lineage that
# renews forever and reaches no client. Serving a certificate per name would
# mean per-name server blocks and a lineage-aware deploy hook; see
# myDocs/domain-certificate-migration.md before going that way.
#
# Leave DOMAINS empty to fall back to a certificate for the Elastic IP itself.
# That path needs no DNS at all, which is what it was for, but IP identifiers
# are only accepted under the "shortlived" profile (160 hours) and certbot
# renews at *half* of a lifetime that short rather than the usual third --
# roughly every 3.3 days. A domain certificate uses the default 90-day
# profile, so this is the constraint being escaped, not a preference.
DOMAINS=(bachbosua.site www.bachbosua.site tramlai.work www.tramlai.work)
#
# CloudFront would have supplied this instead, on a *.cloudfront.net name, and
# would additionally have kept the origin private behind prefix list
# pl-31a34658 with managed policies CachingOptimized 658327ea-..., CachingDisabled
# 4135ea2d-... and AllViewer 216adef6-.... It is unavailable: this account
# returns "Your account must be verified before you can add new CloudFront
# resources", which requires an AWS Support case. Recorded here because it is
# the first thing to revisit if that verification ever lands.

# Resource names. Used by both deploy.sh and teardown.sh; teardown deletes
# exactly what these name and nothing else.
ECR_API_REPO="${PROJECT}-api"
ECR_WEB_REPO="${PROJECT}-web"
GHA_ROLE_NAME="${PROJECT}-gha-ecr-push"
EC2_ROLE_NAME="${PROJECT}-ec2-role"
EC2_PROFILE_NAME="${PROJECT}-ec2-profile"
SG_NAME="${PROJECT}-origin-sg"
INSTANCE_NAME="${PROJECT}-host"
OIDC_PROVIDER_URL="token.actions.githubusercontent.com"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
