#!/usr/bin/env bash
#
# Provision the demo stack. Idempotent: re-running reuses whatever already
# exists and only creates what is missing.
#
#   ./infra/deploy.sh                 # deploy images tagged with HEAD
#   IMAGE_TAG=<sha> ./infra/deploy.sh # deploy a specific build
#
# The address is allocated before the instance because everything else depends
# on knowing it: DNS for every name in DOMAINS has to already point at it for
# http-01 validation to succeed, and with DOMAINS empty the certificate is
# issued *for* that IP directly.
#
# CloudFront was the original design and would have supplied TLS on a
# *.cloudfront.net name. This account cannot create distributions -- AWS
# returns "Your account must be verified before you can add new CloudFront
# resources", which needs a support case. The instance terminates TLS itself
# instead, with a Let's Encrypt certificate for the names in DOMAINS -- or for
# the Elastic IP when that array is empty. See
# myDocs/aws-deployment-shape-decision.md.

source "$(dirname "$0")/config.sh"

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse HEAD)}"
API_IMAGE="${ECR_REGISTRY}/${ECR_API_REPO}:${IMAGE_TAG}"
WEB_IMAGE="${ECR_REGISTRY}/${ECR_WEB_REPO}:${IMAGE_TAG}"

# First boot bakes docker-compose.prod.yml into user-data, but update.sh fetches
# it from raw.githubusercontent.com at the deployed commit. Those two agree only
# if the tree is clean and the commit is pushed -- otherwise the first redeploy
# silently swaps in a different config than the one provisioned here.
if [ -n "$(git status --porcelain -- "$(dirname "$0")")" ]; then
  echo "WARNING: infra/ has uncommitted changes." >&2
  echo "         The instance will boot with your working copy, but update.sh" >&2
  echo "         fetches infra/docker-compose.prod.yml from ${IMAGE_TAG:0:12}," >&2
  echo "         so the first redeploy would revert them." >&2
fi
if ! git merge-base --is-ancestor "$IMAGE_TAG" "origin/main" 2>/dev/null; then
  echo "WARNING: ${IMAGE_TAG:0:12} is not on origin/main." >&2
  echo "         update.sh will not be able to fetch the compose file for it." >&2
fi

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

# What the certificate is issued *for*, and therefore what the app is reached
# at. Two mutually exclusive shapes, decided by whether config.sh names any
# domains. Both are assembled here rather than in user-data.sh because
# user-data has no access to config.sh -- it receives literals through the sed
# substitution below.
#
# --cert-name pins the lineage directory name so nothing downstream has to
# guess which lineage is current, and --expand makes a re-run that adds a name
# expand the existing certificate instead of stopping at a prompt it cannot
# show under --non-interactive.
PRIMARY_DOMAIN="${DOMAINS[0]:-}"
if [ -n "$PRIMARY_DOMAIN" ]; then
  APP_URL="https://${PRIMARY_DOMAIN}"
  CERTBOT_ID_ARGS="--cert-name ${PRIMARY_DOMAIN} --expand $(printf -- '-d %s ' "${DOMAINS[@]}")"
  BOOTSTRAP_CN="$PRIMARY_DOMAIN"
  BOOTSTRAP_SAN="DNS:${PRIMARY_DOMAIN}"
else
  APP_URL="https://${EIP_ADDR}"
  CERTBOT_ID_ARGS="--cert-name ${EIP_ADDR} --preferred-profile shortlived --ip-address ${EIP_ADDR}"
  BOOTSTRAP_CN="$EIP_ADDR"
  BOOTSTRAP_SAN="IP:${EIP_ADDR}"
fi
echo "    app URL ${APP_URL}"

# --- Security group -----------------------------------------------------------
log "Security group ${SG_NAME}"
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=${SG_NAME}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group --group-name "$SG_NAME" \
    --description "Public endpoint for the ${PROJECT} demo" --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)
  # Open to the internet on both ports. With CloudFront in front this would
  # have been the CloudFront prefix list only, but the instance is now the
  # public endpoint, so it has to accept public traffic.
  #
  # Port 80 is not optional and is not just a redirect convenience: Let's
  # Encrypt validates the http-01 challenge over plain HTTP, on every renewal.
  # Closing it would work until the certificate expired six days later.
  #
  # Still no port 22. Shell access is Session Manager, which opens nothing.
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions \
      "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=ACME http-01 and redirect}]" \
      "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=Application}]" \
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
      -e "s|__ECR_API_REPO__|${ECR_API_REPO}|g" \
      -e "s|__ECR_WEB_REPO__|${ECR_WEB_REPO}|g" \
      -e "s|__GITHUB_OWNER__|${GITHUB_OWNER}|g" \
      -e "s|__GITHUB_REPO__|${GITHUB_REPO}|g" \
      -e "s|__API_IMAGE__|${API_IMAGE}|g" \
      -e "s|__WEB_IMAGE__|${WEB_IMAGE}|g" \
      -e "s|__CORS_ORIGIN__|${APP_URL}|g" \
      -e "s|__CERTBOT_ID_ARGS__|${CERTBOT_ID_ARGS}|g" \
      -e "s|__BOOTSTRAP_CN__|${BOOTSTRAP_CN}|g" \
      -e "s|__BOOTSTRAP_SAN__|${BOOTSTRAP_SAN}|g" \
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
# Associate as early as possible. cloud-init will ask Let's Encrypt to validate
# this address, and that only succeeds once the address actually routes here.
aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$EIP_ALLOC" >/dev/null
echo "    ${EIP_ADDR} associated"

cat <<SUMMARY

  URL          ${APP_URL}
  Health       ${APP_URL}/api/health
  Instance     ${INSTANCE_ID}  (${INSTANCE_TYPE}, ${EIP_ADDR})
  Image tag    ${IMAGE_TAG}

  Bootstrap takes a few minutes -- Docker install, image pull, migrations,
  seed, then certificate issuance. Follow it with:
    aws ssm start-session --target ${INSTANCE_ID}
    sudo tail -f /var/log/scheduler-bootstrap.log

SUMMARY
