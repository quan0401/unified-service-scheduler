#!/bin/bash
#
# First-boot bootstrap. Rendered by deploy.sh, which substitutes every __TOKEN__
# below, then passed to run-instances as user-data.
#
# cloud-init runs this once, as root, with no TTY. Everything here has to be
# non-interactive and has to tolerate being re-run, because a rebuild of the
# instance replays it from the top.
set -euxo pipefail
exec > >(tee -a /var/log/scheduler-bootstrap.log) 2>&1

APP_DIR=/opt/scheduler
REGION="__AWS_REGION__"
REGISTRY="__ECR_REGISTRY__"

export DEBIAN_FRONTEND=noninteractive

# --- Docker, from Docker's own repository ------------------------------------
#
# Not Ubuntu's docker.io. The deployment mechanism is `docker compose`, and
# Compose v2 ships as the docker-compose-plugin package, which only Docker's
# repository carries. This is the reason the host is Ubuntu rather than Amazon
# Linux 2023 -- AL2023 packages neither, and download.docker.com has no
# amazonlinux path at all.
apt-get update -y
apt-get install -y ca-certificates curl gnupg unzip

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# --- AWS CLI v2 ---------------------------------------------------------------
#
# Needed only for `ecr get-login-password`. Ubuntu's archive version lags, and
# the official installer is the documented path.
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi

# --- Application files --------------------------------------------------------
mkdir -p "$APP_DIR/data/postgres"
cd "$APP_DIR"

# The compose file arrives base64-encoded on one line. Multi-line substitution
# into user-data is fragile; a single opaque token is not.
echo "__COMPOSE_B64__" | base64 -d > "$APP_DIR/docker-compose.yml"

# Generated once and kept. Regenerating on every boot would orphan the existing
# data directory, whose role password was set by initdb on first start.
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<ENVFILE
POSTGRES_PASSWORD=$(openssl rand -hex 24)
API_IMAGE=__API_IMAGE__
WEB_IMAGE=__WEB_IMAGE__
CORS_ORIGIN=__CORS_ORIGIN__
ENVFILE
  chmod 600 "$APP_DIR/.env"
else
  # Image tags do change between deploys; the password must not.
  sed -i "s|^API_IMAGE=.*|API_IMAGE=__API_IMAGE__|" "$APP_DIR/.env"
  sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=__WEB_IMAGE__|" "$APP_DIR/.env"
  sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=__CORS_ORIGIN__|" "$APP_DIR/.env"
fi

# --- Redeploy helper ----------------------------------------------------------
#
# Invoked later via SSM Run Command so a new image does not require rebuilding
# the instance. Kept here rather than in deploy.sh because it must exist on the
# box, not on the operator's laptop.
cat > "$APP_DIR/update.sh" <<'UPDATE'
#!/bin/bash
set -euxo pipefail
cd /opt/scheduler
REGION=$(cloud-init query region 2>/dev/null || echo "__AWS_REGION__")
REGISTRY=$(grep -oP '(?<=^API_IMAGE=)[^/]+' .env)
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f
UPDATE
chmod +x "$APP_DIR/update.sh"

# --- Start --------------------------------------------------------------------
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker compose pull
docker compose up -d

# The API container applies migrations at startup, so the exclusion constraints
# exist before anything is seeded. Wait for readiness rather than racing it.
for i in $(seq 1 60); do
  if docker compose exec -T api node -e "fetch('http://localhost:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 5
done

# Seed exactly once. A reboot replays user-data, and re-seeding would truncate
# and rebuild the tables the reviewer is looking at.
if [ ! -f "$APP_DIR/.seeded" ]; then
  docker compose run --rm api pnpm db:seed && touch "$APP_DIR/.seeded"
fi

echo "bootstrap complete"
