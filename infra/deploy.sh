#!/usr/bin/env bash
#
# Provision the demo stack. Idempotent: re-running reuses whatever already
# exists and only creates what is missing.
#
#   ./infra/deploy.sh                 # deploy images tagged with HEAD
#   IMAGE_TAG=<sha> ./infra/deploy.sh # deploy a specific build
#
# Ordering is deliberate and avoids a chicken-and-egg. The API's CORS_ORIGIN
# has to name the CloudFront URL, and CloudFront's origin has to name the
# instance's DNS. Both are satisfied by allocating the address first, deriving
# the origin hostname from it, and creating the distribution before the
# instance -- CreateDistribution returns the domain immediately, long before
# the distribution finishes deploying.

source "$(dirname "$0")/config.sh"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse HEAD)}"
API_IMAGE="${ECR_REGISTRY}/${ECR_API_REPO}:${IMAGE_TAG}"
WEB_IMAGE="${ECR_REGISTRY}/${ECR_WEB_REPO}:${IMAGE_TAG}"

log "Checking images exist in ECR (tag ${IMAGE_TAG:0:12})"
for repo in "$ECR_API_REPO" "$ECR_WEB_REPO"; do
  if ! aws ecr describe-images --repository-name "$repo" --image-ids imageTag="$IMAGE_TAG" >/dev/null 2>&1; then
    echo "ERROR: ${repo}:${IMAGE_TAG} not found in ECR." >&2
    echo "       Push to main and let the CI publish job build it, or set IMAGE_TAG." >&2
    exit 1
  fi
  echo "    ${repo}:${IMAGE_TAG:0:12} ok"
done

# --- Elastic IP ---------------------------------------------------------------
log "Elastic IP"
EIP_ALLOC=$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=${INSTANCE_NAME}" \
  --query 'Addresses[0].AllocationId' --output text)
if [ "$EIP_ALLOC" = "None" ] || [ -z "$EIP_ALLOC" ]; then
  EIP_ALLOC=$(aws ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${INSTANCE_NAME}}]" \
    --query 'AllocationId' --output text)
fi
EIP_ADDR=$(aws ec2 describe-addresses --allocation-ids "$EIP_ALLOC" --query 'Addresses[0].PublicIp' --output text)
# AWS derives the public hostname from the address; this form is stable.
ORIGIN_DNS="ec2-${EIP_ADDR//./-}.${AWS_DEFAULT_REGION}.compute.amazonaws.com"
echo "    ${EIP_ADDR}  ->  ${ORIGIN_DNS}"

# --- CloudFront ---------------------------------------------------------------
log "CloudFront distribution"
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${CF_COMMENT}'].Id | [0]" --output text 2>/dev/null || echo "None")

if [ "$DIST_ID" = "None" ] || [ -z "$DIST_ID" ]; then
  DIST_CONFIG=$(cat <<JSON
{
  "CallerReference": "${PROJECT}-$(date +%s)",
  "Comment": "${CF_COMMENT}",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "ec2-origin",
      "DomainName": "${ORIGIN_DNS}",
      "CustomOriginConfig": {
        "HTTPPort": 80,
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "http-only",
        "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
        "OriginReadTimeout": 30,
        "OriginKeepaliveTimeout": 5
      }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "ec2-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "${CF_CACHE_OPTIMIZED}",
    "AllowedMethods": {
      "Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    },
    "Compress": true
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [{
      "PathPattern": "/api/*",
      "TargetOriginId": "ec2-origin",
      "ViewerProtocolPolicy": "redirect-to-https",
      "CachePolicyId": "${CF_CACHE_DISABLED}",
      "OriginRequestPolicyId": "${CF_ORIGIN_ALL_VIEWER}",
      "AllowedMethods": {
        "Quantity": 7,
        "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
      },
      "Compress": true
    }]
  },
  "PriceClass": "PriceClass_All",
  "ViewerCertificate": { "CloudFrontDefaultCertificate": true }
}
JSON
)
  DIST_ID=$(aws cloudfront create-distribution --distribution-config "$DIST_CONFIG" \
    --query 'Distribution.Id' --output text)
fi
CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)
APP_URL="https://${CF_DOMAIN}"
echo "    ${DIST_ID}  ->  ${APP_URL}"

# --- Security group -----------------------------------------------------------
log "Security group ${SG_NAME}"
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=${SG_NAME}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name "$SG_NAME" \
    --description "Origin for ${CF_COMMENT}; CloudFront only" --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)
  # Only CloudFront's origin-facing ranges. The instance is not reachable on
  # its public address, so bypassing the CDN is not possible. No port 22 rule:
  # shell access is Session Manager, which needs no inbound anything.
  #
  # This prefix list has weight 55 against a default quota of 60 rules, so
  # there is room for four more rules here and no more.
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,PrefixListIds=[{PrefixListId=${CF_PREFIX_LIST_ID}}]" \
    >/dev/null
fi
echo "    ${SG_ID}"

# --- Instance profile ---------------------------------------------------------
log "Instance profile ${EC2_PROFILE_NAME}"
if ! aws iam get-role --role-name "$EC2_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$EC2_ROLE_NAME" \
    --description "Scheduler host: SSM access and ECR pull" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
fi
for policy in AmazonSSMManagedInstanceCore AmazonEC2ContainerRegistryReadOnly; do
  aws iam attach-role-policy --role-name "$EC2_ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/${policy}"
done
if ! aws iam get-instance-profile --instance-profile-name "$EC2_PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$EC2_PROFILE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$EC2_PROFILE_NAME" --role-name "$EC2_ROLE_NAME"
  # IAM is eventually consistent and run-instances fails if the profile is not
  # yet visible. This is the one unavoidable sleep in the script.
  sleep 15
fi
echo "    ready"

# --- Instance -----------------------------------------------------------------
log "Instance ${INSTANCE_NAME} (${INSTANCE_TYPE})"
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  COMPOSE_B64=$(base64 < "$(dirname "$0")/docker-compose.prod.yml" | tr -d '\n')
  USER_DATA=$(mktemp)
  sed -e "s|__AWS_REGION__|${AWS_DEFAULT_REGION}|g" \
      -e "s|__ECR_REGISTRY__|${ECR_REGISTRY}|g" \
      -e "s|__API_IMAGE__|${API_IMAGE}|g" \
      -e "s|__WEB_IMAGE__|${WEB_IMAGE}|g" \
      -e "s|__CORS_ORIGIN__|${APP_URL}|g" \
      -e "s|__COMPOSE_B64__|${COMPOSE_B64}|g" \
      "$(dirname "$0")/user-data.sh" > "$USER_DATA"

  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "resolve:ssm:${AMI_SSM_PARAM}" \
    --instance-type "$INSTANCE_TYPE" \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile "Name=${EC2_PROFILE_NAME}" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${ROOT_VOLUME_GB},VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}" \
    --user-data "file://${USER_DATA}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}}]" \
    --query 'Instances[0].InstanceId' --output text)
  rm -f "$USER_DATA"
fi
echo "    ${INSTANCE_ID}"

log "Waiting for instance to run"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$EIP_ALLOC" >/dev/null
echo "    ${EIP_ADDR} associated"

cat <<SUMMARY

  URL          ${APP_URL}
  Health       ${APP_URL}/api/health
  Instance     ${INSTANCE_ID}  (${INSTANCE_TYPE}, ${EIP_ADDR})
  Distribution ${DIST_ID}
  Image tag    ${IMAGE_TAG}

  Bootstrap takes a few minutes and CloudFront a few more. Follow it with:
    aws ssm start-session --target ${INSTANCE_ID}
    sudo tail -f /var/log/scheduler-bootstrap.log

SUMMARY
