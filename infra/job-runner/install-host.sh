#!/usr/bin/env bash
# WP-C1 (D-32 / Q-45a): installerer vertstjenestene (job-runner + egress-proxy) fra dette repoet. IDEMPOTENT og ødelegger aldri eierens
# konfig/hemmeligheter: /etc/jarvis/job-runner.json og PAT-filene opprettes/overskrives ALDRI; bearer-tokenet genereres kun hvis det mangler.
#
#   sudo infra/job-runner/install-host.sh                 # installer på verten
#   infra/job-runner/install-host.sh --stage --prefix DIR # ingen root: skriv samme filtre til DIR (kontroll/tester), uten brukere/systemctl
#
# Kode installeres ROOT-EID og skrivebeskyttet for tjenestebrukerne (en kompromittert prosess kan ikke endre sin egen kode eller policy):
#   /opt/jarvis-job-runner/ops/job-runner/**                        (uten test/)
#   /opt/jarvis-job-runner/modules/tasks/src/job-container-spec.mjs (delt container-spesifikasjon - EN kilde, se docs/runbooks/JOB_RUNNER.md)
#   /opt/jarvis-job-runner/infra/job-runner/setup-network.sh
#   /etc/systemd/system/jarvis-job-runner.service, jarvis-egress-proxy.service
#   /etc/jarvis/job-runner.example.json, /etc/jarvis/job-runner.token (kun hvis den mangler)
set -euo pipefail

STAGE=0
PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=1; shift ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    *) echo "ukjent argument: $1" >&2; exit 2 ;;
  esac
done
if [ "$STAGE" = "1" ] && [ -z "$PREFIX" ]; then echo "--stage krever --prefix DIR" >&2; exit 2; fi
if [ -n "$PREFIX" ] && [ "$STAGE" = "0" ]; then echo "--prefix er kun tillatt sammen med --stage" >&2; exit 2; fi
if [ "$STAGE" = "0" ] && [ "$(id -u)" != "0" ]; then echo "må kjøres som root (bruk sudo), eller --stage --prefix DIR for en rotfri forhåndsvisning" >&2; exit 2; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CODE="$PREFIX/opt/jarvis-job-runner"
ETC="$PREFIX/etc/jarvis"
UNITS="$PREFIX/etc/systemd/system"
RUNNER_UID=10001
CLIENT_GROUP="jarvis-job-clients"

say() { echo "== $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "mangler $1" >&2; exit 2; }; }

# --- forutsetninger ---
need node
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node >= 22 kreves (fant $(node --version))" >&2; exit 2; }
if [ "$STAGE" = "0" ]; then
  need docker; need git; need iptables; need iptables-restore
  GITV="$(git --version | sed -n 's/^git version \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
  read -r GMAJ GMIN <<<"$GITV"
  { [ "${GMAJ:-0}" -gt 2 ] || { [ "${GMAJ:-0}" -eq 2 ] && [ "${GMIN:-0}" -ge 39 ]; }; } || { echo "git >= 2.39 kreves (fant $(git --version))" >&2; exit 2; }
  getent group docker >/dev/null || { echo "docker-gruppen finnes ikke" >&2; exit 2; }
fi

# --- brukere og grupper (kun ekte installasjon) ---
if [ "$STAGE" = "0" ]; then
  say "brukere og grupper"
  getent group "$CLIENT_GROUP" >/dev/null || groupadd --system "$CLIENT_GROUP"
  if id -u jarvis-runner >/dev/null 2>&1; then
    [ "$(id -u jarvis-runner)" = "$RUNNER_UID" ] || echo "ADVARSEL: jarvis-runner har uid $(id -u jarvis-runner), ikke $RUNNER_UID. 'runner.user' i job-runner.json MÅ ha samme uid (runneren må eie filene containeren skriver)." >&2
  else
    useradd --system --uid "$RUNNER_UID" --gid "$CLIENT_GROUP" --home-dir /var/lib/jarvis-job-runner --no-create-home --shell /usr/sbin/nologin jarvis-runner
  fi
  id -u jarvis-egress >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin jarvis-egress
fi

# --- kode: ryddes og kopieres på nytt hver gang (ingen gamle filer blir liggende) ---
say "kode -> $CODE"
rm -rf "$CODE/ops/job-runner" "$CODE/infra/job-runner" "$CODE/modules/tasks/src"
install -d -m 0755 "$CODE" "$CODE/ops" "$CODE/modules" "$CODE/modules/tasks" "$CODE/modules/tasks/src" "$CODE/infra"
(
  cd "$ROOT"
  find ops/job-runner -type f -name '*.mjs' ! -path 'ops/job-runner/test/*' -print0 | while IFS= read -r -d '' f; do
    install -D -m 0644 "$f" "$CODE/$f"
  done
  install -D -m 0644 modules/tasks/src/job-container-spec.mjs "$CODE/modules/tasks/src/job-container-spec.mjs"
  install -D -m 0755 infra/job-runner/setup-network.sh "$CODE/infra/job-runner/setup-network.sh"
)
if [ "$STAGE" = "0" ]; then chown -R root:root "$CODE"; fi

# --- systemd-enheter ---
say "systemd-enheter -> $UNITS"
install -d -m 0755 "$UNITS"
install -m 0644 "$HERE/jarvis-job-runner.service" "$UNITS/jarvis-job-runner.service"
install -m 0644 "$HERE/jarvis-egress-proxy.service" "$UNITS/jarvis-egress-proxy.service"

# --- /etc/jarvis: eksempel alltid, ekte konfig ALDRI, token kun hvis den mangler ---
say "konfig -> $ETC"
install -d -m 0755 "$ETC"
install -m 0644 "$HERE/job-runner.example.json" "$ETC/job-runner.example.json"
if [ ! -e "$ETC/job-runner.token" ]; then
  umask 077
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex") + "\n")' > "$ETC/job-runner.token"
  if [ "$STAGE" = "0" ]; then chown root:"$CLIENT_GROUP" "$ETC/job-runner.token"; fi
  chmod 0640 "$ETC/job-runner.token"
  echo "generert nytt bearer-token i $ETC/job-runner.token (vises aldri)"
else
  echo "beholder eksisterende $ETC/job-runner.token"
fi
[ -e "$ETC/job-runner.json" ] && echo "beholder eksisterende $ETC/job-runner.json (ikke rørt)" || echo "MANGLER $ETC/job-runner.json - kopier job-runner.example.json og tilpass (image, repo, PAT-filer)"

if [ "$STAGE" = "0" ]; then
  systemctl daemon-reload
fi

cat <<MSG

Installert. Neste steg (se docs/runbooks/JOB_RUNNER.md for detaljer):
  1. sudo cp $ETC/job-runner.example.json $ETC/job-runner.json && sudo chown root:root $ETC/job-runner.json && sudo chmod 0644 $ETC/job-runner.json
     og rediger: image (fra build-job-image.sh), allowed_repos, git_credentials.
  2. Legg PAT-filen (fine-grained, ETT repo, Contents: write + Pull requests: write) i $ETC/git-token-<repo>
     med: chown jarvis-runner og chmod 0400 (KUN runner-brukeren; worker skal aldri kunne lese den). Selve tokenet skal ALDRI limes inn i chat eller env.
  3. sudo systemctl enable --now jarvis-egress-proxy jarvis-job-runner
  4. ACCEPTANCE_REPO=<sandbox-repo> ops/job-runner/acceptance.sh
MSG
