#!/usr/bin/env bash
#
# Delete everything deploy.sh created, in reverse order.
#
#   ./infra/teardown.sh            # leaves ECR images and the CI role alone
#   ALL=1 ./infra/teardown.sh      # also deletes ECR repos, CI role, OIDC provider
#
# Two traps this handles that a naive script does not:
#   * A CloudFront distribution cannot be deleted while enabled. It must be
#     disabled, and the disable must finish deploying -- several minutes --
#     before DeleteDistribution is accepted.
#   * An Elastic IP costs $0.005/hour whether attached or idle. Releasing it is
#     not optional cleanup; it is the difference between $0 and $3.65 a month.

source "$(dirname "$0")/config.sh"

log "Instance"
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")
if [ "$INSTANCE_ID" != "None" ] && [ -n "$INSTANCE_ID" ]; then
  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null
  echo "    terminating ${INSTANCE_ID}"
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"
else
  echo "    none"
fi

log "Elastic IP"
EIP_ALLOC=$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=${INSTANCE_NAME}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$EIP_ALLOC" != "None" ] && [ -n "$EIP_ALLOC" ]; then
  aws ec2 release-address --allocation-id "$EIP_ALLOC"
  echo "    released ${EIP_ALLOC}"
else
  echo "    none"
fi

log "CloudFront distribution"
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CF_COMMENT}'].Id | [0]" --output text 2>/dev/null || echo "None")
if [ "$DIST_ID" != "None" ] && [ -n "$DIST_ID" ]; then
  ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query 'ETag' --output text)
  ENABLED=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query 'DistributionConfig.Enabled' --output text)
  if [ "$ENABLED" = "True" ]; then
    aws cloudfront get-distribution-config --id "$DIST_ID" --query 'DistributionConfig' > /tmp/cf-config.json
    python3 -c "
import json
c = json.load(open('/tmp/cf-config.json'))
c['Enabled'] = False
json.dump(c, open('/tmp/cf-config.json', 'w'))
"
    aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" \
      --distribution-config file:///tmp/cf-config.json >/dev/null
    echo "    disabled; waiting for deployment (several minutes)"
    aws cloudfront wait distribution-deployed --id "$DIST_ID"
    ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query 'ETag' --output text)
  fi
  aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$ETAG"
  echo "    deleted ${DIST_ID}"
else
  echo "    none"
fi

log "Security group"
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=${SG_NAME}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" != "None" ] && [ -n "$SG_ID" ]; then
  aws ec2 delete-security-group --group-id "$SG_ID" && echo "    deleted ${SG_ID}"
else
  echo "    none"
fi

log "Instance profile and role"
if aws iam get-instance-profile --instance-profile-name "$EC2_PROFILE_NAME" >/dev/null 2>&1; then
  aws iam remove-role-from-instance-profile --instance-profile-name "$EC2_PROFILE_NAME" --role-name "$EC2_ROLE_NAME" || true
  aws iam delete-instance-profile --instance-profile-name "$EC2_PROFILE_NAME"
  echo "    deleted ${EC2_PROFILE_NAME}"
fi
if aws iam get-role --role-name "$EC2_ROLE_NAME" >/dev/null 2>&1; then
  for policy in AmazonSSMManagedInstanceCore AmazonEC2ContainerRegistryReadOnly; do
    aws iam detach-role-policy --role-name "$EC2_ROLE_NAME" \
      --policy-arn "arn:aws:iam::aws:policy/${policy}" || true
  done
  aws iam delete-role --role-name "$EC2_ROLE_NAME"
  echo "    deleted ${EC2_ROLE_NAME}"
fi

if [ "${ALL:-0}" = "1" ]; then
  log "ECR repositories"
  for repo in "$ECR_API_REPO" "$ECR_WEB_REPO"; do
    aws ecr delete-repository --repository-name "$repo" --force >/dev/null 2>&1 \
      && echo "    deleted ${repo}" || echo "    ${repo} absent"
  done

  log "GitHub Actions role and OIDC provider"
  aws iam delete-role-policy --role-name "$GHA_ROLE_NAME" --policy-name ecr-push 2>/dev/null || true
  aws iam delete-role --role-name "$GHA_ROLE_NAME" 2>/dev/null \
    && echo "    deleted ${GHA_ROLE_NAME}" || echo "    ${GHA_ROLE_NAME} absent"
  aws iam delete-open-id-connect-provider \
    --open-id-connect-provider-arn "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_URL}" 2>/dev/null \
    && echo "    deleted OIDC provider" || echo "    OIDC provider absent"
fi

log "Remaining billable resources in ${AWS_DEFAULT_REGION}"
aws ec2 describe-instances --filters "Name=instance-state-name,Values=running,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 describe-addresses --query 'Addresses[].PublicIp' --output text
