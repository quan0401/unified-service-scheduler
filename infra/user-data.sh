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
    -subj "/CN=__BOOTSTRAP_CN__" -addext "subjectAltName=__BOOTSTRAP_SAN__"
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
# Invoked later via SSM Run Command so a new build does not require rebuilding
# the instance. Kept here rather than in deploy.sh because it must exist on the
# box, not on the operator's laptop.
#
# A redeploy has to move two things together, which is what the first version of
# this script got wrong. The image tags in .env are immutable commit SHAs, so
# `docker compose pull` on its own re-fetches a tag that is already local and
# changes nothing; and any setting that lives in docker-compose.yml rather than
# in the image is not an image change at all. So this fetches the compose file
# from the same commit the images were built from, which keeps the two in step
# by construction. The repository is public, so no credential is involved.
cat > "$APP_DIR/update.sh" <<'UPDATE'
#!/bin/bash
#
# Redeploy onto a different build.
#
#   update.sh              deploy whatever commit currently carries `latest`
#   update.sh <commit-sha> deploy one specific commit
#
# Only commits that reached main have images, because the CI publish job is
# gated on the test job -- so a SHA that resolves here is a SHA whose tests
# passed. Refuses to touch anything until both images and the compose file for
# that commit are confirmed to exist, and rolls back if the result is unhealthy.
set -euo pipefail

APP_DIR=/opt/scheduler
REGION="__AWS_REGION__"
REGISTRY="__ECR_REGISTRY__"
API_REPO="__ECR_API_REPO__"
WEB_REPO="__ECR_WEB_REPO__"
RAW_BASE="https://raw.githubusercontent.com/__GITHUB_OWNER__/__GITHUB_REPO__"

cd "$APP_DIR"
log() { echo "[update] $*"; }

# --- Resolve the target commit ------------------------------------------------
# `latest` and the commit SHA are two tags on one manifest, so with no argument
# the SHA can be read back out of the registry rather than passed in.
SHA="${1:-}"
if [ -z "$SHA" ]; then
  SHA=$(aws ecr describe-images --region "$REGION" --repository-name "$API_REPO" \
          --image-ids imageTag=latest --query 'imageDetails[0].imageTags' --output text 2>/dev/null \
        | tr '\t' '\n' | grep -E '^[0-9a-f]{40}$' | head -1 || true)
fi
if ! echo "$SHA" | grep -qE '^[0-9a-f]{40}$'; then
  log "could not resolve a commit SHA to deploy (got '${SHA:-<empty>}')"
  exit 1
fi
log "target commit $SHA"

# --- Refuse to start unless everything for that commit exists -----------------
for repo in "$API_REPO" "$WEB_REPO"; do
  if ! aws ecr describe-images --region "$REGION" --repository-name "$repo" \
         --image-ids imageTag="$SHA" >/dev/null 2>&1; then
    log "$repo has no image tagged $SHA"
    exit 1
  fi
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL --retry 3 --retry-delay 2 \
       "$RAW_BASE/$SHA/infra/docker-compose.prod.yml" -o "$TMP/docker-compose.yml"; then
  log "could not fetch infra/docker-compose.prod.yml at $SHA"
  exit 1
fi

# The password and CORS origin belong to the instance, not to the build, so the
# existing .env is edited rather than regenerated.
cp .env "$TMP/.env"
sed -i -E "s#^(API_IMAGE=.*/${API_REPO}):.*#\1:${SHA}#" "$TMP/.env"
sed -i -E "s#^(WEB_IMAGE=.*/${WEB_REPO}):.*#\1:${SHA}#" "$TMP/.env"

# Catches a malformed file or an unset variable before it can take the site down.
if ! docker compose -f "$TMP/docker-compose.yml" --env-file "$TMP/.env" config -q; then
  log "compose file at $SHA is not valid with this .env"
  exit 1
fi

# --- Roll ---------------------------------------------------------------------
BACKUP="$APP_DIR/.rollback"
rm -rf "$BACKUP" && mkdir -p "$BACKUP"
cp docker-compose.yml .env "$BACKUP/"

install -m 644 "$TMP/docker-compose.yml" "$APP_DIR/docker-compose.yml"
install -m 600 "$TMP/.env" "$APP_DIR/.env"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker compose pull
docker compose up -d --remove-orphans

# --- Health gate --------------------------------------------------------------
ready() {
  docker compose exec -T api node -e \
    "fetch('http://localhost:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}
for _ in $(seq 1 30); do ready && break; sleep 5; done

if ! ready; then
  log "$SHA did not become ready; rolling back"
  install -m 644 "$BACKUP/docker-compose.yml" "$APP_DIR/docker-compose.yml"
  install -m 600 "$BACKUP/.env" "$APP_DIR/.env"
  docker compose up -d --remove-orphans
  log "rolled back"
  exit 1
fi

docker image prune -f
log "deployed $SHA"
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
# A Let's Encrypt certificate, for the domains named in config.sh or -- when
# none are -- for the Elastic IP itself. deploy.sh decides which and passes the
# identifiers in through a substituted token; everything else here is the same
# either way.
#
#   * The webroot plugin, not nginx or apache: those two do not support IP
#     identifiers at all, and standalone would need port 80 that nginx is
#     already holding. Webroot serves the challenge out of the shared volume,
#     which works for both identifier types.
#   * The snap ships a systemd timer that runs `certbot renew` twice daily.
#     That walks every lineage in /etc/letsencrypt/renewal independently and
#     runs each one's saved deploy hook, so nothing below needs re-running.
#   * On the IP path, renewal is load-bearing rather than housekeeping: IP
#     identifiers force the 160-hour "shortlived" profile, and certbot renews
#     at half of a lifetime that short -- roughly every 3.3 days. A domain
#     certificate gets the default 90-day profile.
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
LIVE="${RENEWED_LINEAGE:-$(find /etc/letsencrypt/live -maxdepth 1 -mindepth 1 -type d | head -1)}"
cp -L "$LIVE/fullchain.pem" /opt/scheduler/certs/fullchain.pem
cp -L "$LIVE/privkey.pem"   /opt/scheduler/certs/privkey.pem
chmod 644 /opt/scheduler/certs/fullchain.pem
chmod 600 /opt/scheduler/certs/privkey.pem
docker exec scheduler-web nginx -s reload
HOOK
chmod +x "$APP_DIR/deploy-cert.sh"

# No email: renewal is automated by the timer, so expiry notices are noise,
# and this script lives in a public repository.
# The identifier token below is deliberately unquoted: it is substituted as
# several words (--cert-name, --expand, and one -d per name) and must
# word-split.
# shellcheck disable=SC2086
certbot certonly \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot --webroot-path "$APP_DIR/webroot" \
  __CERTBOT_ID_ARGS__ \
  --deploy-hook "$APP_DIR/deploy-cert.sh" \
  || echo "WARNING: certificate issuance failed; the self-signed placeholder is still in place"

echo "bootstrap complete"
