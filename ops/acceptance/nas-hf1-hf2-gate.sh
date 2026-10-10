#!/usr/bin/env bash
# HF1/HF2 NAS-akseptanse (WP-J, D-450): ÉN kommando på NAS-en som samler maskinlesbar EVIDENS for byggeprogrammet etter UA-0 (job-runner, backup, kunnskapskilder, business OS,
# finans D-kjede, hendelser, AI Mesh, kontrollsentre ...) i ett dokument - uten hemmeligheter. Kjør den ETTER `docs/runbooks/NAS_UPDATE_HF1_HF2.md` og FØR den felles verifiseringsøkten
# (`docs/runbooks/VERIFICATION_SESSION_HF1_HF2.md`).
#   ops/acceptance/nas-hf1-hf2-gate.sh                          # kjør mot kjørende compose-stack (fra repoets rot på NAS)
#   JARVIS_ACCEPTANCE_DRY_RUN=1 ops/acceptance/nas-hf1-hf2-gate.sh   # skriv kun sjekklisten (ingen docker)
# Valgfritt miljø: JARVIS_COMPOSE_FILE, JARVIS_ACCEPTANCE_OUT_DIR (evidensmappe; standard ops/acceptance/out), JARVIS_UA0_GATE (UA-0-scriptet som kjøres først; standard nas-ua0-gate.sh),
# JARVIS_BACKUP_DIR (videresendes til UA-0-scriptet).
# Leser aldri .env og skriver aldri passord/tokens: miljøvariabler rapporteres som «satt/ikke satt» (verdien vises KUN for en lukket liste ufarlige verdier: on/off/true/false/host/tall);
# Postgres nås via lokal socket i containeren; kun antall/navn/tilstand rapporteres.
# Utdata: stdout + ops/acceptance/out/nas-hf1-hf2-gate-<tid>.md (git-ignorert). Exit 1 hvis minst én sjekk er FAIL; UNKNOWN/WARN er IKKE bestått. INFO er opplysninger (ingen vurdering).
# Ærlighet: «PASS» betyr bare at DENNE målingen var som forventet akkurat nå - ikke at en UA-/EV-rad er lukket. Rader i lukkingsmatrisen blir først VERIFIED når en evidensfil (record-evidence.mjs) lenker til dem.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
UA0_GATE="${JARVIS_UA0_GATE:-$HERE/nas-ua0-gate.sh}"
DRY="${JARVIS_ACCEPTANCE_DRY_RUN:-0}"
OUT_DIR="${JARVIS_ACCEPTANCE_OUT_DIR:-$HERE/out}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/nas-hf1-hf2-gate-$STAMP.md"
PASS=0; FAIL=0; WARN=0; UNKNOWN=0; INFO=0
ROWS=()

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
psqlq() { dc exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-jarvis}" -tA -c "$1"' _ "$1" 2>/dev/null; }

record() { # id status detail
  local id="$1" status="$2" detail="$3"
  case "$status" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; WARN) WARN=$((WARN+1));; UNKNOWN) UNKNOWN=$((UNKNOWN+1));; INFO) INFO=$((INFO+1));; esac
  ROWS+=("| $id | $status | ${detail//|//} |")
  printf '%-26s %-8s %s\n' "$id" "$status" "$detail"
}

CHECKS=(H00_code_version H01_ua0_gate H02_migrations_applied H03_rls_global_tables H04_feature_flags H05_exact_on_flags H06_job_runner H07_backup_status H08_sweep_failures_24h H09_incident_state H10_knowledge_state H11_business_state H12_secrets_in_logs)

if [ "$DRY" = "1" ]; then
  echo "TØRRKJØRING - sjekklisten (ingen docker kjøres):"
  for c in "${CHECKS[@]}"; do echo "  $c"; done
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på NAS-en" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "finner ikke $COMPOSE_FILE" >&2; exit 2; }

# H00: hvilken kode evidensen gjelder (git-SHA står også i evidensfilene fra record-evidence.mjs)
sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"; branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"; dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | head -n1)"
if [ -z "$sha" ]; then record H00_code_version UNKNOWN "fikk ikke lest git-versjon (er dette et git-uttrekk?)"
elif [ -n "$dirty" ]; then record H00_code_version WARN "$branch @ $sha - arbeidskatalogen har lokale endringer (evidensen gjelder ikke ren kode)"
else record H00_code_version INFO "$branch @ $sha (ren arbeidskatalog)"; fi

# H01: UA-0-porten først (compose, migrasjoner, pgvector, helse, lokal modell, kost, EV-0, backup, RLS, herding)
if [ -x "$UA0_GATE" ] || [ -f "$UA0_GATE" ]; then
  ua0_out="$(JARVIS_ACCEPTANCE_OUT_DIR="$OUT_DIR" bash "$UA0_GATE" 2>&1)"; ua0_rc=$?
  ua0_sum="$(echo "$ua0_out" | grep -E '^Sammendrag:' | tail -n1)"
  if [ "$ua0_rc" -eq 0 ]; then record H01_ua0_gate PASS "${ua0_sum:-UA-0-porten ga exit 0}"
  elif [ "$ua0_rc" -eq 1 ]; then record H01_ua0_gate FAIL "UA-0-porten har FAIL: ${ua0_sum:-se utdataene fra nas-ua0-gate.sh}"
  else record H01_ua0_gate UNKNOWN "UA-0-porten kunne ikke kjøre (exit $ua0_rc)"; fi
else record H01_ua0_gate UNKNOWN "finner ikke UA-0-scriptet ($UA0_GATE)"; fi

# H02: alle migrasjoner i repoet er anvendt (nye tabeller for kunnskap, business, finans, hendelser ...)
repo_migs="$(ls "$ROOT/modules/core/src/db/migrations" 2>/dev/null | grep -E '^[0-9]{3}_.*\.sql$' | sort)"
db_migs="$(psqlq "SELECT name FROM schema_migrations ORDER BY name" | sort)"
if [ -z "$db_migs" ]; then record H02_migrations_applied UNKNOWN "fikk ikke lest schema_migrations"
else
  pending="$(comm -23 <(echo "$repo_migs") <(echo "$db_migs") | tr '\n' ' ')"
  last_repo="$(echo "$repo_migs" | tail -n1)"; last_db="$(echo "$db_migs" | tail -n1)"
  if [ -z "$pending" ]; then record H02_migrations_applied PASS "alle $(echo "$repo_migs" | wc -l | tr -d ' ') anvendt, siste: $last_db"
  else record H02_migrations_applied FAIL "ikke anvendt: ${pending}(repo: $last_repo, database: $last_db) - kjør migrate-tjenesten (NAS_UPDATE_HF1_HF2.md)"; fi
fi

# H03: tabeller UTEN rad-nivå-sikkerhet er nøyaktig de dokumenterte globale (listen leses fra CI-testen, så den ikke blir foreldet når en ny global tabell dokumenteres)
exempt_file="$ROOT/modules/core/test/remediation-2-schema-invariants.test.ts"
expected_no_rls="$(awk '/const RLS_EXEMPT/{f=1;next} f&&/^  };/{exit} f{ if (match($0,/^    [a-z_0-9]+:/)) print substr($0,RSTART+4,RLENGTH-5) }' "$exempt_file" 2>/dev/null | sort | paste -sd, -)"
norls="$(psqlq "SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND NOT (relrowsecurity AND relforcerowsecurity)")"
if [ -z "$(psqlq 'SELECT 1')" ]; then record H03_rls_global_tables UNKNOWN "fikk ikke kontakt med databasen"
elif [ -z "$expected_no_rls" ]; then record H03_rls_global_tables UNKNOWN "kunne ikke lese listen over dokumenterte globale tabeller fra $exempt_file"
elif [ "$norls" = "$expected_no_rls" ]; then record H03_rls_global_tables PASS "FORCE RLS på alle tabeller unntatt de $(echo "$expected_no_rls" | tr ',' '\n' | wc -l | tr -d ' ') dokumenterte globale"
else record H03_rls_global_tables FAIL "avvik fra dokumenterte globale tabeller. Funnet uten FORCE RLS: ${norls:-ingen} | Forventet: $expected_no_rls"; fi

# H04: hvilke dormante funksjoner er slått på (kun «satt/ikke satt»; verdi vises bare for ufarlige verdier). INFO - dette er opplysninger til økten, ingen vurdering.
safe_env() { # tjeneste navn...
  local svc="$1"; shift
  local envdump; envdump="$(dc exec -T "$svc" env 2>/dev/null | tr -d '\r')"
  [ -n "$envdump" ] || { echo "ukjent"; return 1; }
  local out="" name val line
  for name in "$@"; do
    line="$(echo "$envdump" | grep -E "^${name}=" | head -n1)"
    if [ -z "$line" ]; then out="$out $name=ikke-satt"; continue; fi
    val="${line#*=}"
    if [ -z "$val" ]; then out="$out $name=ikke-satt"
    elif echo "$val" | grep -qE '^(on|off|true|false|host|[0-9]{1,6})$'; then out="$out $name=$val"
    else out="$out $name=satt"; fi
  done
  echo "$out"
}
API_FLAGS=(JARVIS_COUNCIL_PROPOSALS JARVIS_KNOWLEDGE_CLAIM_WRITES JARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES JARVIS_BUSINESS_TENANT_PROVISIONING JARVIS_PRODUCT_USAGE_TENANT_ID JARVIS_OWNER_EXTRA_TENANTS JARVIS_INCIDENT_PRODUCERS_ENABLED JARVIS_V2_PUSH_ENABLED JARVIS_V5_PROPOSALS_ENABLED JARVIS_UPTIME_HEARTBEAT_URL JARVIS_RADAR_SOURCES JARVIS_GITHUB_APP_ID JARVIS_MESH_TOOLS_VERIFIED JARVIS_CHAT_CANDIDATES JARVIS_JOB_RUNNER)
WORKER_FLAGS=(JARVIS_KNOWLEDGE_SOURCES JARVIS_KNOWLEDGE_FS_ROOTS JARVIS_KNOWLEDGE_ENTITY_LLM JARVIS_JOB_RUNNER JARVIS_JOB_RUNNER_SOCKET JARVIS_INCIDENT_PRODUCERS_ENABLED JARVIS_SUPPORT_SLA_HOURS)
api_flags="$(safe_env api "${API_FLAGS[@]}")"; api_rc=$?
worker_flags="$(safe_env worker "${WORKER_FLAGS[@]}")"; worker_rc=$?
if [ "$api_rc" -ne 0 ] && [ "$worker_rc" -ne 0 ]; then record H04_feature_flags UNKNOWN "fikk ikke lest miljøet i api/worker"
else record H04_feature_flags INFO "api:${api_flags:- ukjent} | worker:${worker_flags:- ukjent}"; fi

# H05: flagg som KUN aktiveres av eksakt «on»/«true» - nesten-treff (ON, 1, yes) er stille AV. Et slikt flagg er nesten alltid en feilskriving.
bad=""
check_exact() { # tjeneste navn gyldig-på-verdi
  local svc="$1" name="$2" on="$3" val
  val="$(dc exec -T "$svc" env 2>/dev/null | tr -d '\r' | grep -E "^${name}=" | head -n1)"; val="${val#*=}"
  [ -z "$val" ] && return 0
  [ "$val" = "$on" ] && return 0
  [ "$val" = "off" ] || [ "$val" = "false" ] && return 0
  bad="$bad $name(verdi ikke $on/off)"
}
check_exact api JARVIS_KNOWLEDGE_CLAIM_WRITES on; check_exact api JARVIS_COUNCIL_PROPOSALS on
check_exact api JARVIS_INCIDENT_PRODUCERS_ENABLED true; check_exact worker JARVIS_INCIDENT_PRODUCERS_ENABLED true
if [ -z "$(dc exec -T api env 2>/dev/null | head -n1)" ]; then record H05_exact_on_flags UNKNOWN "fikk ikke lest miljøet i api"
elif [ -z "$bad" ]; then record H05_exact_on_flags PASS "ingen flagg står med en nesten-riktig verdi"
else record H05_exact_on_flags WARN "flagg som er STILLE AV pga. verdien:$bad"; fi

# H06: vertsside job-runner (D-32): hvis den er slått på, må socketen finnes inne i containeren og runneren svare
runner_mode="$(dc exec -T worker env 2>/dev/null | tr -d '\r' | grep -E '^JARVIS_JOB_RUNNER=' | head -n1)"; runner_mode="${runner_mode#*=}"
if [ -z "$(dc exec -T worker env 2>/dev/null | head -n1)" ]; then record H06_job_runner UNKNOWN "fikk ikke lest miljøet i worker"
elif [ "$runner_mode" != "host" ]; then record H06_job_runner INFO "ikke aktivert (JARVIS_JOB_RUNNER=${runner_mode:-ikke satt}); kodejobber feiler lukket"
else
  sock="$(dc exec -T worker env 2>/dev/null | tr -d '\r' | grep -E '^JARVIS_JOB_RUNNER_SOCKET=' | head -n1)"; sock="${sock#*=}"
  if [ -z "$sock" ]; then record H06_job_runner FAIL "JARVIS_JOB_RUNNER=host, men JARVIS_JOB_RUNNER_SOCKET er ikke satt i worker"
  elif dc exec -T worker sh -c 'test -S "$1"' _ "$sock" >/dev/null 2>&1; then record H06_job_runner PASS "host-modus; socketen finnes i worker-containeren"
  else record H06_job_runner FAIL "host-modus, men socketen finnes ikke i worker-containeren (er override-filen infra/job-runner/docker-compose.job-runner.yml brukt, og kjører runneren?)"; fi
fi

# H07: backup-status (WP-C2): statusfilen runneren skriver, lest fra api-containeren (montert :ro). Alder og tilstand; ingen filnavn eller innhold utover tilstandskoder.
bstat="$(dc exec -T api node -e "const f=process.env.JARVIS_BACKUP_STATUS_FILE; if(!f){console.log('NOFILE');process.exit(0)} try{const j=JSON.parse(require('fs').readFileSync(f,'utf8'));const age=Math.round((Date.now()-Date.parse(j.generated_at))/3600000);console.log([j.backup&&j.backup.state,j.restore_verify&&j.restore_verify.state,j.offsite&&j.offsite.state,'age_h='+age].join(' '))}catch(e){console.log('ERR')}" 2>/dev/null | tr -d '\r')"
case "$bstat" in
  NOFILE) record H07_backup_status INFO "JARVIS_BACKUP_STATUS_FILE er ikke satt i api (planlagt backup ikke installert)";;
  ERR|"") record H07_backup_status UNKNOWN "statusfilen finnes ikke eller kan ikke leses fra api-containeren";;
  *) if echo "$bstat" | grep -qE 'failing|never'; then record H07_backup_status WARN "$bstat"; else record H07_backup_status PASS "$bstat"; fi;;
esac

# H08: sveip/jobber som feilet siste døgn (D-442/D-443: feilede planlagte jobber skal ikke være stille)
sweep="$(dc logs --no-log-prefix --since 24h api worker 2>/dev/null | grep -E '_sweep_failed|sweep_failure|knowledge_source_failed|knowledge_source_timeout|open_loop_sweep_tenant_failed|product_usage_purge_failed' | sed -E 's/.*"msg":"([a-z_]+)".*/\1/' | sort | uniq -c | sort -rn | head -n 8 | tr '\n' ';' | sed 's/  */ /g')"
if [ -z "$(dc ps -q api 2>/dev/null)" ]; then record H08_sweep_failures_24h UNKNOWN "fikk ikke lest loggene (api kjører ikke?)"
elif [ -z "$sweep" ]; then record H08_sweep_failures_24h PASS "ingen sveip-/kildefeil i loggene siste 24 t"
else record H08_sweep_failures_24h WARN "feil siste 24 t (antall melding): $sweep"; fi

# H09-H11: tilstand (antall/navn) for funksjonene som ble bygget - viser om de faktisk kjører. Kun INFO: en dormant funksjon uten data er forventet.
table_exists() { [ "$(psqlq "SELECT to_regclass('public.$1') IS NOT NULL")" = "t" ]; }
if table_exists incident_transitions; then
  inc="$(psqlq "SELECT coalesce(string_agg(status||':'||n, ' '), 'ingen') FROM (SELECT status, count(*)::int AS n FROM incidents GROUP BY status ORDER BY status) t")"
  record H09_incident_state INFO "hendelser per status: ${inc:-ukjent}"
elif [ -z "$(psqlq 'SELECT 1')" ]; then record H09_incident_state UNKNOWN "fikk ikke kontakt med databasen"
else record H09_incident_state INFO "incident_transitions finnes ikke (E1 ikke utrullet)"; fi

if table_exists knowledge_documents; then
  kd="$(psqlq "SELECT coalesce(string_agg(source_type||':'||n, ' '), 'ingen') FROM (SELECT source_type, count(*)::int AS n FROM knowledge_documents WHERE NOT deleted GROUP BY source_type ORDER BY source_type) t")"
  cl="$(table_exists claim_verifications && psqlq "SELECT coalesce(string_agg(status||':'||n, ' '), 'ingen') FROM (SELECT status, count(*)::int AS n FROM claim_verifications GROUP BY status ORDER BY status) t" || echo "tabell mangler")"
  record H10_knowledge_state INFO "dokumenter per kilde: ${kd:-ukjent} | påstander per status: ${cl:-ukjent}"
else record H10_knowledge_state UNKNOWN "knowledge_documents finnes ikke"; fi

if table_exists product_usage_events; then
  bt="$(psqlq "SELECT count(*)::int FROM tenants WHERE kind='business'")"
  pu="$(psqlq "SELECT count(*)::int FROM product_usage_events")"
  ch="$(table_exists business_change_log && psqlq "SELECT count(*)::int FROM business_change_log" || echo "tabell mangler")"
  record H11_business_state INFO "bedrifts-tenanter: ${bt:-?} | produktbruk-hendelser: ${pu:-?} | endringslogg-rader: ${ch:-?}"
else record H11_business_state INFO "product_usage_events finnes ikke (D2 ikke utrullet)"; fi

# H12: ingen hemmelighetsformer i loggene siste 5000 linjer (api + worker). Treff rapporteres KUN som antall per mønster-navn - aldri som tekst.
logs="$(dc logs --no-log-prefix --tail 5000 api worker 2>/dev/null)"
if [ -z "$logs" ]; then record H12_secrets_in_logs UNKNOWN "fikk ikke lest loggene"
else
  hits=""
  scan() { local name="$1" re="$2" n; n="$(echo "$logs" | grep -cE -e "$re")"; [ "${n:-0}" -gt 0 ] && hits="$hits $name=$n"; }
  scan private_key '-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----'
  scan github_token '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}'
  scan anthropic_key 'sk-ant-[A-Za-z0-9_-]{20,}'
  scan slack_token 'xox[abprs]-[A-Za-z0-9-]{10,}'
  scan aws_key '(AKIA|ASIA)[0-9A-Z]{16}'
  scan bearer 'Bearer [A-Za-z0-9._~+/=-]{24,}'
  scan url_credentials '[a-z][a-z0-9+.-]{1,12}://[^ /@:]{1,100}:[^ /@]{1,200}@'
  if [ -z "$hits" ]; then record H12_secrets_in_logs PASS "ingen kjente hemmelighetsformer i de siste 5000 loggradene (api+worker)"
  else record H12_secrets_in_logs FAIL "hemmelighetsformer i loggene (antall rader per mønster):$hits - roter berørt nøkkel og finn kilden"; fi
fi

write_evidence() {
  echo "# HF1/HF2 NAS-akseptanse - $STAMP"
  echo
  echo "Generert av \`ops/acceptance/nas-hf1-hf2-gate.sh\` (WP-J, D-450). Ingen hemmeligheter; kun antall/navn/tilstand. PASS betyr at denne målingen var som forventet akkurat nå - ikke at en UA-/EV-rad er lukket (det krever evidensfil + vurdering i økten)."
  echo
  echo "Sammendrag: PASS=$PASS WARN=$WARN UNKNOWN=$UNKNOWN FAIL=$FAIL INFO=$INFO"
  echo
  echo "| Sjekk | Status | Detalj |"
  echo "|---|---|---|"
  printf '%s\n' "${ROWS[@]}"
}
# Som UA-0-porten: evidensfilen er best effort, men scriptet skal aldri PÅSTÅ at den ble skrevet når den ikke ble det. Utdataene på skjermen er alltid evidensen; filen er en kopi.
evidence_ok=0
if mkdir -p "$OUT_DIR" 2>/dev/null; then
  chmod 700 "$OUT_DIR" 2>/dev/null || true
  if ( write_evidence > "$OUT_FILE" ) 2>/dev/null; then evidence_ok=1; fi
fi
echo
echo "Sammendrag: PASS=$PASS WARN=$WARN UNKNOWN=$UNKNOWN FAIL=$FAIL INFO=$INFO"
if [ "$evidence_ok" = "1" ]; then
  echo "Evidens skrevet til: $OUT_FILE"
else
  echo "ADVARSEL: evidensfilen ble IKKE skrevet ($OUT_DIR er ikke skrivbar for $(id -un)). Eies mappen av en annen bruker (for eksempel root etter en tidligere sudo-kjøring), rett den med: sudo chown -R $(id -un):$(id -gn) $OUT_DIR - eller sett JARVIS_ACCEPTANCE_OUT_DIR til en skrivbar mappe. Utdataene over er eneste evidens fra denne kjøringen." >&2
fi
[ "$FAIL" -eq 0 ]
