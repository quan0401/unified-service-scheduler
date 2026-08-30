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
PUBLIC_IP="__PUBLIC_IP__"

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
mkdir -p "$APP_DIR/data/postgres" "$APP_DIR/certs" "$APP_DIR/webroot"
cd "$APP_DIR"

# nginx will not start without a certificate at these paths, and the real one
# cannot be issued until nginx is up to answer the http-01 challenge. A
# self-signed placeholder breaks the cycle; certbot's deploy hook overwrites it
# minutes later and reloads. Browsers never see it unless issuance fails, which
# is exactly when a loud warning is what you want.
if [ ! -f "$APP_DIR/certs/fullchain.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
    -keyout "$APP_DIR/certs/privkey.pem" \
    -out "$APP_DIR/certs/fullchain.pem" \
    -subj "/CN=${PUBLIC_IP}" -addext "subjectAltName=IP:${PUBLIC_IP}"
  chmod 644 "$APP_DIR/certs/fullchain.pem"
  chmod 600 "$APP_DIR/certs/privkey.pem"
fi

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

# --- TLS ----------------------------------------------------------------------
#
# A Let's Encrypt certificate for the Elastic IP itself, so the demo is HTTPS
# without owning a domain. Two constraints come with that:
#
#   * IP address certificates are only issued under the "shortlived" profile
#     (160 hours). Renewal is not housekeeping here -- miss it for a week and
#     the site breaks. The snap ships a systemd timer that runs twice daily.
#   * The nginx and apache certbot plugins do not support IP identifiers. Only
#     manual, standalone, and webroot do, and standalone would need port 80 that
#     nginx is already holding. Hence webroot, served out of the shared volume.
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot

# Webroot support for IP addresses landed in certbot 5.4. Failing loudly beats
# issuing nothing and leaving the self-signed placeholder in place silently.
CERTBOT_VER=$(certbot --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
echo "certbot ${CERTBOT_VER}"

# Copies whatever certbot just issued to the fixed paths nginx reads, then asks
# nginx to pick them up. Registered as a deploy hook below, so it also runs on
# every renewal, unattended, for the life of the instance.
cat > "$APP_DIR/deploy-cert.sh" <<'HOOK'
#!/bin/bash
set -euo pipefail
LIVE=$(find /etc/letsencrypt/live -maxdepth 1 -mindepth 1 -type d | head -1)
cp -L "$LIVE/fullchain.pem" /opt/scheduler/certs/fullchain.pem
cp -L "$LIVE/privkey.pem"   /opt/scheduler/certs/privkey.pem
chmod 644 /opt/scheduler/certs/fullchain.pem
chmod 600 /opt/scheduler/certs/privkey.pem
docker exec scheduler-web nginx -s reload
HOOK
chmod +x "$APP_DIR/deploy-cert.sh"

# No email: with six-day certs and an automated timer, expiry notices are noise,
# and this script lives in a public repository.
certbot certonly \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot --webroot-path "$APP_DIR/webroot" \
  --ip-address "$PUBLIC_IP" \
  --deploy-hook "$APP_DIR/deploy-cert.sh" \
  || echo "WARNING: certificate issuance failed; the self-signed placeholder is still in place"

echo "bootstrap complete"
