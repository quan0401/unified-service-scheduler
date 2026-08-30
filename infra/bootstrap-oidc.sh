#!/usr/bin/env bash
#
# One-time account setup so GitHub Actions can push images without static keys.
#
#   ./infra/bootstrap-oidc.sh
#
# Creates, idempotently:
#   * an IAM OIDC identity provider for GitHub's token issuer
#   * a role GitHub Actions assumes, scoped to one repo and one branch
#   * the two ECR repositories the workflow pushes to
#
# Re-running is safe: every step checks for the resource first.

source "$(dirname "$0")/config.sh"

OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_URL}"

log "IAM OIDC provider for ${OIDC_PROVIDER_URL}"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "    exists, skipping"
else
  # No --thumbprint-list. Since 2023-07-06 AWS validates GitHub's IdP against
  # its own trusted root CA store; a thumbprint supplied here is ignored, and
  # pinning one was the historical cause of breakage on certificate rotation.
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_PROVIDER_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --query 'OpenIDConnectProviderArn' --output text
fi

log "Role ${GHA_ROLE_NAME}"
# The sub condition is the whole security boundary. Without it any GitHub
# repository in the world could assume this role. Pinned to one branch of one
# repo so a pull request from a fork cannot publish an image.
TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_PROVIDER_URL}:aud": "sts.amazonaws.com",
        "${OIDC_PROVIDER_URL}:sub": "repo:${GITHUB_OWNER}/${GITHUB_REPO}:ref:refs/heads/main"
      }
    }
  }]
}
JSON
)

if aws iam get-role --role-name "$GHA_ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$GHA_ROLE_NAME" --policy-document "$TRUST"
  echo "    exists, trust policy refreshed"
else
  aws iam create-role --role-name "$GHA_ROLE_NAME" \
    --description "GitHub Actions pushes scheduler images to ECR" \
    --assume-role-policy-document "$TRUST" \
    --query 'Role.Arn' --output text
fi

# GetAuthorizationToken cannot be scoped to a repository -- the API grants a
# registry-wide token or nothing -- so it sits in its own statement on "*".
# Everything that actually touches an image is scoped to the two repos.
aws iam put-role-policy --role-name "$GHA_ROLE_NAME" --policy-name "ecr-push" \
  --policy-document "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": [
        "arn:aws:ecr:${AWS_DEFAULT_REGION}:${ACCOUNT_ID}:repository/${ECR_API_REPO}",
        "arn:aws:ecr:${AWS_DEFAULT_REGION}:${ACCOUNT_ID}:repository/${ECR_WEB_REPO}"
      ]
    }
  ]
}
JSON
)"
echo "    inline policy ecr-push attached"

for repo in "$ECR_API_REPO" "$ECR_WEB_REPO"; do
  log "ECR repository ${repo}"
  if aws ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1; then
    echo "    exists, skipping"
  else
    aws ecr create-repository --repository-name "$repo" \
      --image-scanning-configuration scanOnPush=true \
      --query 'repository.repositoryUri' --output text
  fi
done

log "Done. Add this to the workflow as AWS_ROLE_ARN:"
aws iam get-role --role-name "$GHA_ROLE_NAME" --query 'Role.Arn' --output text
