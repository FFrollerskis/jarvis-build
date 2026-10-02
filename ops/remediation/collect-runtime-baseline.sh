#!/usr/bin/env bash
# Remediation part 1: collect the RUNTIME facts the repo cannot show (what the NAS actually runs).
# READ-ONLY. Prints markdown to stdout; paste it into docs/remediation/BASELINE.md ("Runtime evidence").
#   ops/remediation/collect-runtime-baseline.sh > /tmp/jarvis-runtime-baseline.md
#
# Secrets are NEVER printed: .env values are shown only for an allow-list of non-secret flags; every
# other key is reported as set/empty/absent. `docker compose config` is never run with interpolation.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${JARVIS_BASELINE_ROOT:-$(cd "$HERE/../.." && pwd)}"
COMPOSE_FILE="${JARVIS_BASELINE_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
ENV_FILE="${JARVIS_BASELINE_ENV_FILE:-$ROOT/.env}"
DB_USER="${JARVIS_DB_ADMIN_USER:-postgres}"

section() { printf '\n### %s\n\n' "$1"; }
fence() { printf '```\n'; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '# Runtime baseline (collected %s UTC on %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname 2>/dev/null || echo unknown)"

section "Repository"
fence
if have git && git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1; then
  echo "head:      $(git -C "$ROOT" rev-parse HEAD)"
  echo "branch:    $(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  echo "dirty:     $(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ') changed paths"
  echo "remote:    $(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#//[^@/]*@#//#')"
else
  echo "git: not available or not a repository"
fi
fence

section "Containers (docker compose ps)"
fence
if have docker; then
  docker compose -f "$COMPOSE_FILE" ps 2>&1 | sed -E 's/\r$//' || echo "docker compose ps failed"
else
  echo "docker: not available"
fi
fence

section "Image identity per service (what actually runs)"
fence
if have docker; then
  for cid in $(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null); do
    name="$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')"
    image="$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null)"
    imgid="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null)"
    digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$imgid" 2>/dev/null)"
    echo "$name | image=$image | id=$imgid | repo_digests=${digests:-none}"
  done
fi
fence

section "Published ports (docker port) - anything other than 127.0.0.1 is a finding"
fence
if have docker; then
  for cid in $(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null); do
    name="$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')"
    ports="$(docker port "$cid" 2>/dev/null | tr '\n' ';')"
    echo "$name | ${ports:-no published ports}"
  done
fi
fence

section "Host listeners (ss -tln) - 0.0.0.0 / [::] on 3010,3020,3030,3050,3060,5432 is a finding"
fence
if have ss; then
  ss -tlnH 2>/dev/null | awk '{print $4}' | sort -u
else
  echo "ss: not available"
fi
if have ss && ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq '^(0\.0\.0\.0|\[::\]|\*):(3010|3020|3030|3050|3060|5432)$'; then
  echo "FINDING: a Jarvis port listens on all interfaces"
fi
fence

section "Compose publishing as declared (no interpolation, no secrets)"
fence
if have docker; then
  docker compose -f "$COMPOSE_FILE" config --no-interpolate 2>/dev/null | grep -E '^\s+(published|host_ip|target|- "?[0-9.:$\{\}A-Z_a-z-]+:[0-9]+"?)' | head -40 || true
fi
fence

section "Tailscale serve/funnel"
fence
if have tailscale; then tailscale serve status 2>&1 | head -30; else echo "tailscale: not available"; fi
fence

section ".env flags (values only for non-secret allow-list; everything else is presence only)"
fence
NONSECRET="JARVIS_ENV JARVIS_SANDBOX JARVIS_BUDGET_APPROVED JARVIS_API_PORT JARVIS_VOICE_PORT JARVIS_TENANT_ID JARVIS_OWNER_PERSON_ID JARVIS_GITHUB_REPO JARVIS_VOICE_ALLOW_TEST_ADAPTERS JARVIS_SELF_MODIFICATION_ENABLED"
PRESENCE="JARVIS_DB_ADMIN_PASSWORD JARVIS_DB_PASSWORD INFISICAL_ENCRYPTION_KEY INFISICAL_AUTH_SECRET JARVIS_GITHUB_TOKEN JARVIS_TELEGRAM_TOKEN JARVIS_TELEGRAM_CHAT_ID OPENAI_API_KEY JARVIS_GEMMA_LOCAL_URL JARVIS_GEMMA_LOCAL_MODEL JARVIS_VOICE_DEBUG_DUMP_DIR JARVIS_VOICE_DEBUG_DUMP_CONSENT JARVIS_PUBLIC_VOICE_BASE_URL JARVIS_BROWSER_GATEWAY_BASE_URL JARVIS_CLAUDE_BIN"
if [ -f "$ENV_FILE" ]; then
  getval() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }
  for k in $NONSECRET; do
    if grep -qE "^$k=" "$ENV_FILE"; then echo "$k=$(getval "$k")"; else echo "$k=<absent>"; fi
  done
  for k in $PRESENCE; do
    if ! grep -qE "^$k=" "$ENV_FILE"; then echo "$k: absent"; elif [ -z "$(getval "$k")" ]; then echo "$k: empty"; else echo "$k: set"; fi
  done
  echo "blank KEY= lines: $(grep -cE '^[A-Z_0-9]+=$' "$ENV_FILE")"
  echo "duplicate keys: $(grep -E '^[A-Z_0-9]+=' "$ENV_FILE" | cut -d= -f1 | sort | uniq -d | tr '\n' ' ')"
else
  echo "env file not found: $ENV_FILE"
fi
fence

section "Database facts (counts only; read-only; via docker compose exec)"
fence
if have docker; then
  q() { docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U "$DB_USER" -d "$1" -X -A -t -v ON_ERROR_STOP=1 -c "$2" 2>&1 | head -20; }
  echo "migrations applied:      $(q jarvis "SELECT count(*) FROM schema_migrations")"
  echo "tables (public):         $(q jarvis "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  echo "gemma_local cost rows:   $(q jarvis "SELECT count(*) || ' rows, ' || coalesce(sum(amount_ore),0) || ' ore' FROM cost_events WHERE provider='gemma_local' AND amount_ore>0")"
  echo "kill switch rows:        $(q jarvis "SELECT count(*) FROM owner_control_state WHERE control_kind='kill_switch'")"
  echo "scheduler jobs (names):  $(q jarvis "SELECT string_agg(DISTINCT job_name, ', ') FROM scheduler_state")"
  echo "databases:               $(q postgres "SELECT string_agg(datname || '=' || pg_size_pretty(pg_database_size(datname)), ', ') FROM pg_database WHERE NOT datistemplate")"
  echo "queued/running tasks:    $(q jarvis "SELECT count(*) FROM tasks WHERE status IN ('queued','running')" )"
fi
fence

section "Backup status"
fence
if [ -n "${JARVIS_BACKUP_DIR:-}" ] && [ -d "${JARVIS_BACKUP_DIR}" ]; then
  node "$HERE/../backup/jarvis-backup.mjs" status --out "$JARVIS_BACKUP_DIR" 2>&1 || true
else
  echo "JARVIS_BACKUP_DIR not set or not a directory - no backup directory to check"
fi
fence

printf '\nPC worker (Windows) - run in PowerShell and add the result by hand:\n\n'
fence
cat <<'PS'
schtasks /Query /TN JarvisClaudeWorker /V /FO LIST
Get-ScheduledTask -TaskName JarvisClaudeWorker* | Select TaskName, State
PS
fence
