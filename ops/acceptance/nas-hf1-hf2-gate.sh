#!/usr/bin/env bash
# HF1/HF2 NAS-akseptanse (WP-J, D-450): ÉN kommando på NAS-en som samler maskinlesbar EVIDENS for byggeprogrammet etter UA-0 (job-runner, backup, kunnskapskilder, business OS,
# finans D-kjede, hendelser, AI Mesh, kontrollsentre ...) i ett dokument - uten hemmeligheter. Kjør den ETTER `docs/runbooks/NAS_UPDATE_HF1_HF2.md` og FØR den felles verifiseringsøkten
# (`docs/runbooks/VERIFICATION_SESSION_HF1_HF2.md`).
#   ops/acceptance/nas-hf1-hf2-gate.sh                          # kjør mot kjørende compose-stack (fra repoets rot på NAS)
#   JARVIS_ACCEPTANCE_DRY_RUN=1 ops/acceptance/nas-hf1-hf2-gate.sh   # skriv kun sjekklisten (ingen docker)
# Valgfritt miljø: JARVIS_COMPOSE_FILE, JARVIS_ACCEPTANCE_OUT_DIR (evidensmappe; standard ops/acceptance/out), JARVIS_UA0_GATE (UA-0-scriptet som kjøres først; standard nas-ua0-gate.sh),
# JARVIS_BACKUP_DIR (videresendes til UA-0-scriptet), JARVIS_EVIDENCE_RECORDER (record-evidence.mjs som H12 bruker til å skanne loggene med SAMME mønsterliste som evidens-opptakeren; krever node
# på verten), JARVIS_ACCEPTANCE_GIT_ROOT (katalogen H00 leser git-versjon fra), JARVIS_DOCKER_BIN (standard docker).
# Leser aldri .env og skriver aldri passord/tokens: miljøvariabler rapporteres som «satt/ikke satt» (verdien vises KUN for en lukket liste ufarlige verdier: on/off/true/false/host/tall);
# Postgres nås via lokal socket i containeren; kun antall/navn/tilstand rapporteres. Kjør aldri scriptet med `bash -x`: sporingen skriver miljøet til skjermen.
# Utdata: stdout + ops/acceptance/out/nas-hf1-hf2-gate-<tid>.md (git-ignorert). INFO er opplysninger (ingen vurdering); UNKNOWN/WARN er IKKE bestått.
# Exit: 0 = ingen FAIL og minst én PASS; 1 = minst én FAIL; 2 = kan ikke kjøre (docker/compose utilgjengelig); 3 = ingen FAIL, men heller ingen sjekk kunne bekreftes (alt UNKNOWN/WARN/INFO).
# Ærlighet: «PASS» betyr bare at DENNE målingen var som forventet akkurat nå - ikke at en UA-/EV-rad er lukket. Rader i lukkingsmatrisen blir først VERIFIED når en evidensfil (record-evidence.mjs) lenker til dem.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GIT_ROOT="${JARVIS_ACCEPTANCE_GIT_ROOT:-$ROOT}"
DOCKER_BIN="${JARVIS_DOCKER_BIN:-docker}"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
UA0_GATE="${JARVIS_UA0_GATE:-$HERE/nas-ua0-gate.sh}"
RECORDER="${JARVIS_EVIDENCE_RECORDER:-$HERE/record-evidence.mjs}"
DRY="${JARVIS_ACCEPTANCE_DRY_RUN:-0}"
OUT_DIR="${JARVIS_ACCEPTANCE_OUT_DIR:-$HERE/out}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/nas-hf1-hf2-gate-$STAMP.md"
PASS=0; FAIL=0; WARN=0; UNKNOWN=0; INFO=0
ROWS=()
UA0_LINES=()
# verdier som kan vises i klartekst; alt annet rapporteres som «satt»
SAFE_VALUE_RE='^(on|off|true|false|host|[0-9]{1,6})$'

dc() { "$DOCKER_BIN" compose -f "$COMPOSE_FILE" "$@"; }
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

command -v "$DOCKER_BIN" >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på NAS-en" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "finner ikke $COMPOSE_FILE" >&2; exit 2; }
# Uten kontakt med docker-daemonen (nede, eller brukeren har ikke rettigheter) kan INGENTING måles: stopp heller enn å skrive en rekke UNKNOWN som ser ut som en kjøring.
if ! dc ps -q >/dev/null 2>&1; then
  echo "docker compose svarer ikke (daemonen er nede, brukeren mangler docker-rettigheter, eller compose-filen er feil) - ingenting ble målt. På Synology: kjør som en bruker med docker-tilgang, for eksempel med sudo." >&2
  exit 2
fi

# H00: hvilken kode evidensen gjelder (git-SHA står også i evidensfilene fra record-evidence.mjs)
sha="$(git -C "$GIT_ROOT" rev-parse --short HEAD 2>/dev/null)"; branch="$(git -C "$GIT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"; dirty="$(git -C "$GIT_ROOT" status --porcelain 2>/dev/null | head -n1)"
if [ -z "$sha" ]; then record H00_code_version UNKNOWN "fikk ikke lest git-versjon (er dette et git-uttrekk?)"
elif [ -n "$dirty" ]; then record H00_code_version WARN "$branch @ $sha - arbeidskatalogen har lokale endringer (evidensen gjelder ikke ren kode)"
else record H00_code_version INFO "$branch @ $sha (ren arbeidskatalog)"; fi

# H01: UA-0-porten først (compose, migrasjoner, pgvector, helse, lokal modell, kost, EV-0, backup, RLS, herding). Linjer som IKKE er PASS/INFO vises både her og i evidensfilen -
# et grønt sammendrag skal aldri skjule hva som var WARN/UNKNOWN.
if [ -x "$UA0_GATE" ] || [ -f "$UA0_GATE" ]; then
  ua0_out="$(JARVIS_ACCEPTANCE_OUT_DIR="$OUT_DIR" bash "$UA0_GATE" 2>&1)"; ua0_rc=$?
  ua0_sum="$(printf '%s\n' "$ua0_out" | grep -E '^Sammendrag:' | tail -n1)"
  while IFS= read -r ua0_line; do
    [ -n "$ua0_line" ] || continue
    UA0_LINES+=("$ua0_line"); printf '    UA-0> %s\n' "$ua0_line"
  done < <(printf '%s\n' "$ua0_out" | grep -E '^[A-Za-z0-9_]+[[:space:]]+(WARN|UNKNOWN|FAIL)[[:space:]]' | cut -c1-300)
  ua0_warn="$(printf '%s' "$ua0_sum" | sed -nE 's/.*WARN=([0-9]+).*/\1/p')"; ua0_unknown="$(printf '%s' "$ua0_sum" | sed -nE 's/.*UNKNOWN=([0-9]+).*/\1/p')"
  if [ "$ua0_rc" -eq 0 ]; then
    if [ -z "$ua0_sum" ]; then record H01_ua0_gate UNKNOWN "UA-0-porten ga exit 0 uten sammendragslinje - kan ikke vurdere resultatet"
    elif [ "${ua0_warn:-0}" -gt 0 ] || [ "${ua0_unknown:-0}" -gt 0 ]; then record H01_ua0_gate WARN "$ua0_sum - WARN/UNKNOWN i UA-0 er IKKE bestått (linjene står over og i evidensfilen)"
    else record H01_ua0_gate PASS "$ua0_sum"; fi
  elif [ "$ua0_rc" -eq 1 ]; then record H01_ua0_gate FAIL "UA-0-porten har FAIL: ${ua0_sum:-se utdataene fra nas-ua0-gate.sh}"
  else record H01_ua0_gate UNKNOWN "UA-0-porten kunne ikke kjøre (exit $ua0_rc)"; fi
else record H01_ua0_gate UNKNOWN "finner ikke UA-0-scriptet ($UA0_GATE)"; fi

# Databasen måles én gang: mange sjekker nedenfor skal si UNKNOWN (ikke «finnes ikke») når den ikke svarer.
DB_OK=0; [ "$(psqlq 'SELECT 1')" = "1" ] && DB_OK=1

# H02: alle migrasjoner i repoet er anvendt (nye tabeller for kunnskap, business, finans, hendelser ...)
repo_migs="$(ls "$ROOT/modules/core/src/db/migrations" 2>/dev/null | grep -E '^[0-9]{3}_.*\.sql$' | sort)"
db_migs=""; [ "$DB_OK" = "1" ] && db_migs="$(psqlq "SELECT name FROM schema_migrations ORDER BY name" | sort)"
if [ "$DB_OK" != "1" ]; then record H02_migrations_applied UNKNOWN "fikk ikke kontakt med databasen"
elif [ -z "$db_migs" ]; then record H02_migrations_applied UNKNOWN "fikk ikke lest schema_migrations"
else
  pending="$(comm -23 <(echo "$repo_migs") <(echo "$db_migs") | tr '\n' ' ')"
  last_repo="$(echo "$repo_migs" | tail -n1)"; last_db="$(echo "$db_migs" | tail -n1)"
  if [ -z "$pending" ]; then record H02_migrations_applied PASS "alle $(echo "$repo_migs" | wc -l | tr -d ' ') anvendt, siste: $last_db"
  else record H02_migrations_applied FAIL "ikke anvendt: ${pending}(repo: $last_repo, database: $last_db) - kjør migrate-tjenesten (NAS_UPDATE_HF1_HF2.md)"; fi
fi

# H03: tabeller UTEN rad-nivå-sikkerhet er nøyaktig de dokumenterte globale (listen leses fra CI-testen, så den ikke blir foreldet når en ny global tabell dokumenteres)
exempt_file="$ROOT/modules/core/test/remediation-2-schema-invariants.test.ts"
expected_no_rls="$(awk '/const RLS_EXEMPT/{f=1;next} f&&/^  };/{exit} f{ if (match($0,/^    [a-z_0-9]+:/)) print substr($0,RSTART+4,RLENGTH-5) }' "$exempt_file" 2>/dev/null | sort | paste -sd, -)"
norls=""; [ "$DB_OK" = "1" ] && norls="$(psqlq "SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND NOT (relrowsecurity AND relforcerowsecurity)")"
if [ "$DB_OK" != "1" ]; then record H03_rls_global_tables UNKNOWN "fikk ikke kontakt med databasen"
elif [ -z "$expected_no_rls" ]; then record H03_rls_global_tables UNKNOWN "kunne ikke lese listen over dokumenterte globale tabeller fra $exempt_file"
elif [ "$norls" = "$expected_no_rls" ]; then record H03_rls_global_tables PASS "FORCE RLS på alle tabeller unntatt de $(echo "$expected_no_rls" | tr ',' '\n' | wc -l | tr -d ' ') dokumenterte globale"
else record H03_rls_global_tables FAIL "avvik fra dokumenterte globale tabeller. Funnet uten FORCE RLS: ${norls:-ingen} | Forventet: $expected_no_rls"; fi

# Miljøet i api og worker leses ÉN gang hver (kun i minnet, aldri skrevet ut). En tom dump betyr at containeren ikke kunne leses.
API_ENV="$(dc exec -T api env 2>/dev/null | tr -d '\r')"
WORKER_ENV="$(dc exec -T worker env 2>/dev/null | tr -d '\r')"
env_get() { # dump navn -> verdi (første treff; tom hvis den ikke finnes)
  local line; line="$(printf '%s\n' "$1" | grep -E "^${2}=" | head -n1)"
  printf '%s' "${line#*=}"
}

# H04: hvilke dormante funksjoner er slått på (kun «satt/ikke satt»; verdi vises bare for ufarlige verdier). INFO - dette er opplysninger til økten, ingen vurdering.
safe_env() { # dump navn...
  local dump="$1"; shift
  [ -n "$dump" ] || { echo "ukjent"; return 1; }
  local out="" name val
  for name in "$@"; do
    val="$(env_get "$dump" "$name")"
    if [ -z "$val" ]; then out="$out $name=ikke-satt"
    elif printf '%s' "$val" | grep -qE "$SAFE_VALUE_RE"; then out="$out $name=$val"
    else out="$out $name=satt"; fi
  done
  echo "$out"
}
API_FLAGS=(JARVIS_COUNCIL_PROPOSALS JARVIS_KNOWLEDGE_CLAIM_WRITES JARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES JARVIS_BUSINESS_TENANT_PROVISIONING JARVIS_PRODUCT_USAGE_TENANT_ID JARVIS_OWNER_EXTRA_TENANTS JARVIS_INCIDENT_PRODUCERS_ENABLED JARVIS_V2_PUSH_ENABLED JARVIS_V5_PROPOSALS_ENABLED JARVIS_UPTIME_HEARTBEAT_URL JARVIS_RADAR_SOURCES JARVIS_GITHUB_APP_ID JARVIS_MESH_TOOLS_VERIFIED JARVIS_CHAT_CANDIDATES JARVIS_JOB_RUNNER)
WORKER_FLAGS=(JARVIS_KNOWLEDGE_SOURCES JARVIS_KNOWLEDGE_FS_ROOTS JARVIS_KNOWLEDGE_ENTITY_LLM JARVIS_JOB_RUNNER JARVIS_JOB_RUNNER_SOCKET JARVIS_INCIDENT_PRODUCERS_ENABLED JARVIS_SUPPORT_SLA_HOURS)
api_flags="$(safe_env "$API_ENV" "${API_FLAGS[@]}")"; api_rc=$?
worker_flags="$(safe_env "$WORKER_ENV" "${WORKER_FLAGS[@]}")"; worker_rc=$?
if [ "$api_rc" -ne 0 ] && [ "$worker_rc" -ne 0 ]; then record H04_feature_flags UNKNOWN "fikk ikke lest miljøet i api/worker"
else record H04_feature_flags INFO "api:${api_flags:- ukjent} | worker:${worker_flags:- ukjent}"; fi

# H05: flagg som KUN aktiveres av eksakt «on»/«true» - nesten-treff (ON, 1, yes) er stille AV. Et slikt flagg er nesten alltid en feilskriving. PASS krever at BEGGE miljøene kunne leses.
bad=""
check_exact() { # dump navn gyldig-på-verdi
  local val; val="$(env_get "$1" "$2")"
  [ -z "$val" ] && return 0
  [ "$val" = "$3" ] && return 0
  [ "$val" = "off" ] || [ "$val" = "false" ] && return 0
  bad="$bad $2(verdi ikke $3/off)"
}
check_exact "$API_ENV" JARVIS_KNOWLEDGE_CLAIM_WRITES on; check_exact "$API_ENV" JARVIS_COUNCIL_PROPOSALS on
check_exact "$API_ENV" JARVIS_INCIDENT_PRODUCERS_ENABLED true; check_exact "$WORKER_ENV" JARVIS_INCIDENT_PRODUCERS_ENABLED true
unreadable=""; [ -n "$API_ENV" ] || unreadable="$unreadable api"; [ -n "$WORKER_ENV" ] || unreadable="$unreadable worker"
if [ -n "$bad" ]; then record H05_exact_on_flags WARN "flagg som er STILLE AV pga. verdien:$bad${unreadable:+ (miljøet i$unreadable ble ikke lest)}"
elif [ -n "$unreadable" ]; then record H05_exact_on_flags UNKNOWN "fikk ikke lest miljøet i$unreadable - kan ikke vise at flaggene er riktig skrevet"
else record H05_exact_on_flags PASS "ingen flagg står med en nesten-riktig verdi (api og worker lest)"; fi

# H06: vertsside job-runner (D-32): hvis den er slått på, må socketen finnes inne i containeren og runneren svare
runner_mode="$(env_get "$WORKER_ENV" JARVIS_JOB_RUNNER)"
runner_shown="satt"; [ -n "$runner_mode" ] || runner_shown="ikke satt"; if printf '%s' "$runner_mode" | grep -qE "$SAFE_VALUE_RE"; then runner_shown="$runner_mode"; fi
if [ -z "$WORKER_ENV" ]; then record H06_job_runner UNKNOWN "fikk ikke lest miljøet i worker"
elif [ "$runner_mode" != "host" ]; then record H06_job_runner INFO "ikke aktivert (JARVIS_JOB_RUNNER=$runner_shown); kodejobber feiler lukket"
else
  sock="$(env_get "$WORKER_ENV" JARVIS_JOB_RUNNER_SOCKET)"
  if [ -z "$sock" ]; then record H06_job_runner FAIL "JARVIS_JOB_RUNNER=host, men JARVIS_JOB_RUNNER_SOCKET er ikke satt i worker"
  elif dc exec -T worker sh -c 'test -S "$1"' _ "$sock" >/dev/null 2>&1; then record H06_job_runner PASS "host-modus; socketen finnes i worker-containeren"
  else record H06_job_runner FAIL "host-modus, men socketen finnes ikke i worker-containeren (er override-filen infra/job-runner/docker-compose.job-runner.yml brukt, og kjører runneren?)"; fi
fi

# H07: backup-status (WP-C2): den offentlige eksporten runneren skriver (backup-status.json), lest fra api-containeren (montert :ro). Kun tilstandskoder og alder skrives ut - hver kode renses til [a-z_]
# i selve uttrekket, så en ødelagt fil ikke kan smugle noe inn i raden. PASS krever at ALLE tre er «ok» og at filen er ferskere enn 36 t; FAIL ved failing/failed; WARN ved never/never_run/not_configured/pending.
BACKUP_JS='const f=process.env.JARVIS_BACKUP_STATUS_FILE;if(!f){console.log("NOFILE");process.exit(0)}try{const j=JSON.parse(require("fs").readFileSync(f,"utf8"));const t=(x)=>String(x==null?"?":x).replace(/[^a-z_]/g,"").slice(0,20)||"?";const age=Math.round((Date.now()-Date.parse(j.generated_at))/3600000);console.log("backup="+t(j.backup&&j.backup.state)+" restore="+t(j.restore_verify&&j.restore_verify.state)+" offsite="+t(j.offsite&&j.offsite.state)+" age_h="+age)}catch(e){console.log("ERR")}'
BK_STATUS=""; BK_DETAIL=""
classify_backup() { # linje fra uttrekket -> BK_STATUS / BK_DETAIL
  local line="$1" b r o age tok re='^backup=([a-z_?]+) restore=([a-z_?]+) offsite=([a-z_?]+) age_h=(-?[0-9]+|NaN)$'
  if ! [[ "$line" =~ $re ]]; then BK_STATUS=UNKNOWN; BK_DETAIL="uventet format fra statusfilen"; return; fi
  b="${BASH_REMATCH[1]}"; r="${BASH_REMATCH[2]}"; o="${BASH_REMATCH[3]}"; age="${BASH_REMATCH[4]}"
  BK_STATUS=PASS; BK_DETAIL="backup=$b restore_verify=$r offsite=$o age_h=$age"
  for tok in "$b" "$r" "$o"; do
    case "$tok" in
      ok) ;;
      failing|failed) BK_STATUS=FAIL;;
      never|never_run|not_configured|pending) if [ "$BK_STATUS" = "PASS" ]; then BK_STATUS=WARN; fi;;
      *) if [ "$BK_STATUS" != "FAIL" ]; then BK_STATUS=UNKNOWN; fi;;
    esac
  done
  if [ "$age" = "NaN" ] || [ "${age#-}" != "$age" ]; then
    if [ "$BK_STATUS" = "PASS" ] || [ "$BK_STATUS" = "WARN" ]; then BK_STATUS=UNKNOWN; fi
    BK_DETAIL="$BK_DETAIL (alderen kunne ikke tolkes)"
  elif [ "$age" -gt 36 ]; then
    if [ "$BK_STATUS" = "PASS" ]; then BK_STATUS=WARN; fi
    BK_DETAIL="$BK_DETAIL (statusfilen er over 36 t gammel - kjører runneren?)"
  fi
}
bstat="$(dc exec -T api node -e "$BACKUP_JS" 2>/dev/null | tr -d '\r')"
case "$bstat" in
  NOFILE) record H07_backup_status INFO "JARVIS_BACKUP_STATUS_FILE er ikke satt i api (planlagt backup ikke installert)";;
  ERR|"") record H07_backup_status UNKNOWN "statusfilen finnes ikke eller kan ikke leses fra api-containeren";;
  *) classify_backup "$bstat"; record H07_backup_status "$BK_STATUS" "$BK_DETAIL";;
esac

# H08: sveip/synkroniseringer/utrenskinger/kunnskapskilder som feilet siste døgn (D-442/D-443: feilede planlagte jobber skal ikke være stille). Mønsteret er en FAMILIE (…sweep…/…sync…/…purge…/knowledge_source… + _failed/_failure/_timeout),
# kontrollert mot kodens faktiske meldingsnavn (situation_sweep_failed, vipps_sweep_tenant_failed, support_inbox_sync_tenant_failed, vision_retention_purge_failed, knowledge_source_failed ...) - ikke en håndskrevet liste som kan bli vakuøs. Bare meldingsnavnet (snake_case) og antall vises - en treffende linje uten JSON-«msg» telles som
# «annen_loggrad» i stedet for å bli skrevet ut. Uleselige eller tomme logger gir UNKNOWN, aldri PASS.
LOGS24="$(dc logs --no-log-prefix --since 24h api worker 2>/dev/null)"; logs24_rc=$?
if [ -z "$(dc ps -q api 2>/dev/null)" ]; then record H08_sweep_failures_24h UNKNOWN "fikk ikke lest loggene (api kjører ikke?)"
elif [ "$logs24_rc" -ne 0 ] || [ -z "$LOGS24" ]; then record H08_sweep_failures_24h UNKNOWN "fikk ikke lest loggene (docker logs ga exit $logs24_rc eller tomt utdrag)"
else
  sweep="$(printf '%s\n' "$LOGS24" | grep -E '[a-z0-9_]*(sweep|sync|purge|knowledge_source)[a-z0-9_]*_(failed|failure|timeout)' | sed -E 's/.*"msg":"([a-z_]+)".*/\1/; t; s/.*/annen_loggrad/' | sort | uniq -c | sort -rn | head -n 8 | tr '\n' ';' | sed 's/  */ /g')"
  if [ -z "$sweep" ]; then record H08_sweep_failures_24h PASS "ingen sveip-/kildefeil i loggene siste 24 t"
  else record H08_sweep_failures_24h WARN "feil siste 24 t (antall melding): $sweep"; fi
fi

# H09-H11: tilstand (antall/navn) for funksjonene som ble bygget - viser om de faktisk kjører. Kun INFO: en dormant funksjon uten data er forventet. Uten kontakt med databasen er svaret UNKNOWN, aldri «ikke utrullet».
table_exists() { [ "$(psqlq "SELECT to_regclass('public.$1') IS NOT NULL")" = "t" ]; }
if [ "$DB_OK" != "1" ]; then
  record H09_incident_state UNKNOWN "fikk ikke kontakt med databasen"
  record H10_knowledge_state UNKNOWN "fikk ikke kontakt med databasen"
  record H11_business_state UNKNOWN "fikk ikke kontakt med databasen"
else
  if table_exists incident_transitions; then
    inc="$(psqlq "SELECT coalesce(string_agg(status||':'||n, ' '), 'ingen') FROM (SELECT status, count(*)::int AS n FROM incidents GROUP BY status ORDER BY status) t")"
    record H09_incident_state INFO "hendelser per status: ${inc:-ukjent}"
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
fi

# H12: ingen hemmelighetsformer i loggene siste 5000 linjer (api + worker). Skanningen bruker SAMME mønsterliste som evidens-opptakeren (`record-evidence.mjs --scan`, krever node); uten den faller vi
# tilbake til en forenklet liste og kan IKKE gi PASS. Treff rapporteres KUN som antall per mønster-navn - aldri som tekst.
logs="$(dc logs --no-log-prefix --tail 5000 api worker 2>/dev/null)"
if [ -z "$logs" ]; then record H12_secrets_in_logs UNKNOWN "fikk ikke lest loggene"
elif [ -f "$RECORDER" ] && command -v node >/dev/null 2>&1; then
  scan_out="$(printf '%s\n' "$logs" | node "$RECORDER" --scan 2>/dev/null)"; scan_rc=$?
  scan_hits="$(printf '%s\n' "$scan_out" | grep -E '^[a-z0-9_]+=[0-9]+$' | grep -v '^avkortet=' | tr '\n' ' ')"
  scan_cut="$(printf '%s\n' "$scan_out" | grep -c '^avkortet=')"
  if [ "$scan_rc" -eq 1 ] && [ -n "$scan_hits" ]; then record H12_secrets_in_logs FAIL "hemmelighetsformer i loggene (treff per regel): ${scan_hits% } - roter berørt nøkkel og finn kilden"
  elif [ "$scan_rc" -ne 0 ]; then record H12_secrets_in_logs UNKNOWN "skanneren (record-evidence.mjs --scan) feilet med exit $scan_rc"
  elif [ "${scan_cut:-0}" -gt 0 ]; then record H12_secrets_in_logs WARN "ingen treff, men utdraget var større enn skannerens tak og ble avkortet - ikke hele utdraget er skannet"
  else record H12_secrets_in_logs PASS "ingen treff mot opptakerens hele mønsterliste i de siste 5000 loggradene (api+worker)"; fi
else
  hits=""
  scan() { local name="$1" re="$2" n; n="$(printf '%s\n' "$logs" | grep -cE -e "$re")"; [ "${n:-0}" -gt 0 ] && hits="$hits $name=$n"; }
  scan private_key '-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----'
  scan github_token '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}'
  scan anthropic_key 'sk-ant-[A-Za-z0-9_-]{20,}'
  scan slack_token 'xox[abprs]-[A-Za-z0-9-]{10,}'
  scan aws_key '(AKIA|ASIA)[0-9A-Z]{16}'
  scan bearer 'Bearer [A-Za-z0-9._~+/=-]{24,}'
  scan url_credentials '[a-z][a-z0-9+.-]{1,12}://[^ /@:]{1,100}:[^ /@]{1,200}@'
  if [ -n "$hits" ]; then record H12_secrets_in_logs FAIL "hemmelighetsformer i loggene (antall rader per mønster, forenklet liste):$hits - roter berørt nøkkel og finn kilden"
  else record H12_secrets_in_logs WARN "ingen treff på den FORENKLEDE listen (7 mønstre) - opptakeren ($RECORDER) eller node mangler på verten, så full skanning ble ikke gjort; kjør record-evidence.mjs --scan manuelt"; fi
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
  if [ "${#UA0_LINES[@]}" -gt 0 ]; then
    echo
    echo "## UA-0-linjer som ikke er PASS/INFO"
    echo
    echo '```text'
    printf '%s\n' "${UA0_LINES[@]}"
    echo '```'
  fi
}
# Som UA-0-porten: evidensfilen er best effort, men scriptet skal aldri PÅSTÅ at den ble skrevet når den ikke ble det. Utdataene på skjermen er alltid evidensen; filen er en kopi.
# Mappen låses (700) KUN hvis scriptet selv opprettet den - en eksisterende mappe eieren har satt opp rettighetene på røres ikke.
evidence_ok=0
dir_new=0; [ -d "$OUT_DIR" ] || dir_new=1
if mkdir -p "$OUT_DIR" 2>/dev/null; then
  if [ "$dir_new" = "1" ]; then chmod 700 "$OUT_DIR" 2>/dev/null || true; fi
  if ( write_evidence > "$OUT_FILE" ) 2>/dev/null; then evidence_ok=1; fi
fi
echo
echo "Sammendrag: PASS=$PASS WARN=$WARN UNKNOWN=$UNKNOWN FAIL=$FAIL INFO=$INFO"
if [ $((WARN + UNKNOWN)) -gt 0 ]; then
  echo "OBS: $WARN WARN og $UNKNOWN UNKNOWN er IKKE bestått - les radene over før noe kalles verifisert."
fi
if [ "$UNKNOWN" -ge 3 ] && [ "$UNKNOWN" -gt "$PASS" ]; then
  echo "ADVARSEL: de fleste sjekkene kunne ikke måles (docker-, database- eller loggtilgang?). Kjør som en bruker med docker-tilgang (for eksempel med sudo), og kjør på nytt." >&2
fi
if [ "$evidence_ok" = "1" ]; then
  echo "Evidens skrevet til: $OUT_FILE"
else
  echo "ADVARSEL: evidensfilen ble IKKE skrevet ($OUT_DIR er ikke skrivbar for $(id -un)). Eies mappen av en annen bruker (for eksempel root etter en tidligere sudo-kjøring), rett den med: sudo chown -R $(id -un):$(id -gn) $OUT_DIR - eller sett JARVIS_ACCEPTANCE_OUT_DIR til en skrivbar mappe. Utdataene over er eneste evidens fra denne kjøringen." >&2
fi
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$PASS" -eq 0 ]; then exit 3; fi
exit 0
