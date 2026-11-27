#!/usr/bin/env bash
# UA-0 NAS-akseptanse (D-422): ÉN kommando på NAS-en som samler EVIDENS for produksjonsportene i ett dokument - uten hemmeligheter.
#   ops/acceptance/nas-ua0-gate.sh                # kjør mot kjørende compose-stack (fra repoets rot på NAS)
#   JARVIS_ACCEPTANCE_DRY_RUN=1 ops/acceptance/nas-ua0-gate.sh   # skriv kun sjekklisten (ingen docker)
# Valgfritt miljø: JARVIS_BACKUP_DIR (mappen nas-backup.sh skriver til), JARVIS_COMPOSE_FILE, JARVIS_ACCEPTANCE_OUT_DIR (evidensmappe; standard ops/acceptance/out).
# Kun for test: JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD (kjørbar fil som erstatter ops/backup/nas-schedule.sh i C13), JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC (standard 120), JARVIS_ACCEPTANCE_NODE_BIN (standard node). C13-raden får «(OVERSTYRT, kun test)» når en av dem er satt.
# Selve gaten leser aldri .env og skriver aldri passord/tokens: Postgres nås via lokal socket i containeren (ingen passord), og kun antall/navn/tilstand rapporteres. UNNTAK (C13): gaten kjører ops/backup/nas-schedule.sh,
# og DET skriptet leser .env (DB-admin-passordet i sitt EGET miljø, JARVIS_BACKUP_*) og kan bygge age-imaget første gang; gaten viser kun koder og tall fra svaret.
# Utdata: stdout + ops/acceptance/out/nas-ua0-gate-<tid>.md (git-ignorert). Exit 1 hvis minst én sjekk er FAIL; UNKNOWN/WARN er IKKE bestått.
# Ærlighet: «PASS» betyr bare at DENNE målingen var som forventet akkurat nå - ikke at en UA-port er lukket.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
DRY="${JARVIS_ACCEPTANCE_DRY_RUN:-0}"
OUT_DIR="${JARVIS_ACCEPTANCE_OUT_DIR:-$HERE/out}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/nas-ua0-gate-$STAMP.md"
PASS=0; FAIL=0; WARN=0; UNKNOWN=0
ROWS=()

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
psqlq() { dc exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-jarvis}" -tA -c "$1"' _ "$1" 2>/dev/null; }

record() { # id status detail
  local id="$1" status="$2" detail="$3"
  case "$status" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; WARN) WARN=$((WARN+1));; UNKNOWN) UNKNOWN=$((UNKNOWN+1));; esac
  ROWS+=("| $id | $status | ${detail//|//} |")
  printf '%-22s %-8s %s\n' "$id" "$status" "$detail"
}

CHECKS=(C01_compose_services C02_migrations_applied C03_pgvector_hnsw C04_schema_features C05_api_health C06_local_model C07_chat_cost_24h C08_provider_failures_24h C09_ev0_boot C10_backup_freshness C11_rls_tables C12_container_hardening C13_backup_status C14_watchdog_alive)

if [ "$DRY" = "1" ]; then
  echo "TØRRKJØRING - sjekklisten (ingen docker kjøres):"
  for c in "${CHECKS[@]}"; do echo "  $c"; done
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på NAS-en" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "finner ikke $COMPOSE_FILE" >&2; exit 2; }

# C01: tjenester oppe og friske
svc="$(dc ps --format '{{.Service}}={{.State}}/{{.Health}}' 2>/dev/null | sort | tr '\n' ' ')"
if [ -z "$svc" ]; then record C01_compose_services UNKNOWN "fikk ikke lest compose-status"
else
  bad=""
  for s in postgres api worker; do
    echo "$svc" | grep -q "$s=running" || bad="$bad $s"
  done
  if [ -z "$bad" ]; then record C01_compose_services PASS "$svc"; else record C01_compose_services FAIL "ikke running:$bad | $svc"; fi
fi

# C02: alle migrasjonsfiler i repoet er anvendt
repo_migs="$(ls "$ROOT/modules/core/src/db/migrations" 2>/dev/null | grep -E '^[0-9]{3}_.*\.sql$' | sort)"
db_migs="$(psqlq "SELECT name FROM schema_migrations ORDER BY name" | sort)"
if [ -z "$db_migs" ]; then record C02_migrations_applied UNKNOWN "fikk ikke lest schema_migrations"
else
  pending="$(comm -23 <(echo "$repo_migs") <(echo "$db_migs") | tr '\n' ' ')"
  last="$(echo "$db_migs" | tail -n1)"
  if [ -z "$pending" ]; then record C02_migrations_applied PASS "alle anvendt, siste: $last"; else record C02_migrations_applied FAIL "ikke anvendt: $pending(siste anvendt: $last)"; fi
fi

# C03: pgvector + HNSW (D-28)
ext="$(psqlq "SELECT extname FROM pg_extension WHERE extname='vector'")"
hnsw="$(psqlq "SELECT count(*) FROM pg_indexes WHERE indexdef ILIKE '%hnsw%'")"
if [ -z "$ext" ]; then record C03_pgvector_hnsw FAIL "vector-utvidelsen er ikke installert"
elif [ "${hnsw:-0}" -ge 1 ] 2>/dev/null; then record C03_pgvector_hnsw PASS "vector installert, HNSW-indekser: $hnsw"
else record C03_pgvector_hnsw WARN "vector installert, men ingen HNSW-indeks funnet (migrasjon 068 kan ha feilet, jf. D-400)"; fi

# C04: nyere skjemadeler finnes
miss=""
for t in evolution_change_ledger connector_maintenance_log; do
  [ "$(psqlq "SELECT to_regclass('public.$t') IS NOT NULL")" = "t" ] || miss="$miss $t"
done
[ "$(psqlq "SELECT count(*) FROM information_schema.columns WHERE table_name='tasks' AND column_name='delivered_at'")" = "1" ] || miss="$miss tasks.delivered_at"
if [ -z "$(psqlq 'SELECT 1')" ]; then record C04_schema_features UNKNOWN "fikk ikke kontakt med databasen"
elif [ -z "$miss" ]; then record C04_schema_features PASS "evolution_change_ledger, connector_maintenance_log, tasks.delivered_at finnes"
else record C04_schema_features FAIL "mangler:$miss"; fi

# C05: API helse (inkl. databasen)
health="$(dc exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.JARVIS_API_PORT||3010)+'/health').then(r=>console.log(r.status)).catch(e=>console.log('ERR'))" 2>/dev/null | tr -d '\r')"
case "$health" in 200) record C05_api_health PASS "/health = 200";; "") record C05_api_health UNKNOWN "ingen svar fra api-containeren";; *) record C05_api_health FAIL "/health = $health";; esac

# C06: lokal modell nåbar fra api-containeren, og riktige modeller finnes (kun modellnavn, ikke URL)
models="$(dc exec -T api node -e "const u=process.env.JARVIS_GEMMA_LOCAL_URL; if(!u){console.log('NOURL');process.exit(0)} fetch(u.replace(/\/+\$/,'')+'/api/tags',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(j=>console.log((j.models||[]).map(m=>m.name).join(','))).catch(e=>console.log('ERR'))" 2>/dev/null | tr -d '\r')"
case "$models" in
  NOURL) record C06_local_model WARN "JARVIS_GEMMA_LOCAL_URL er ikke satt i api-containeren";;
  ERR|"") record C06_local_model FAIL "lokal modellserver (Ollama) svarer ikke fra api-containeren";;
  *) m1="llama3.1:8b"; if echo "$models" | grep -q "$m1" && echo "$models" | grep -q "bge-m3"; then record C06_local_model PASS "modeller: $models"; else record C06_local_model WARN "nåbar, men forventet llama3.1:8b + bge-m3 mangler: $models"; fi;;
esac

# C07: hvor chat faktisk gikk siste døgn (D-402: skal ikke lekke til betalt sky uten at eier vet det)
cost="$(psqlq "SELECT coalesce(provider,'?')||':'||count(*)||' kall/'||coalesce(sum(amount_ore),0)||' øre' FROM cost_events WHERE at > now() - interval '24 hours' AND purpose='CHAT' GROUP BY provider ORDER BY 1")"
if [ -z "$cost" ]; then record C07_chat_cost_24h UNKNOWN "ingen CHAT-rader siste 24 t (ingen chat, eller ikke målt)"
else
  cloud="$(psqlq "SELECT coalesce(sum(amount_ore),0) FROM cost_events WHERE at > now() - interval '24 hours' AND purpose='CHAT' AND provider NOT IN ('gemma_local','local_llm','ollama','scripted')")"
  if [ "${cloud:-0}" = "0" ]; then record C07_chat_cost_24h PASS "$(echo "$cost" | tr '\n' ' ')- ingen skykostnad"; else record C07_chat_cost_24h WARN "skykostnad ${cloud} øre siste 24 t: $(echo "$cost" | tr '\n' ' ')"; fi
fi

# C08: feilrate per leverandør
fails="$(psqlq "SELECT provider||':'||count(*) FILTER (WHERE NOT success)||'/'||count(*) FROM cost_events WHERE at > now() - interval '24 hours' GROUP BY provider HAVING count(*) FILTER (WHERE NOT success) > 0")"
if [ -z "$(psqlq 'SELECT 1')" ]; then record C08_provider_failures_24h UNKNOWN "fikk ikke kontakt med databasen"
elif [ -z "$fails" ]; then record C08_provider_failures_24h PASS "ingen feilede modellkall siste 24 t"
else record C08_provider_failures_24h WARN "feilede/totalt: $(echo "$fails" | tr '\n' ' ')"; fi

# C09: EV-0 oppstartssjekk (konstitusjon + endringsregister) fra api-loggen
ev0="$(dc logs --no-log-prefix --tail 5000 api 2>/dev/null | grep -E 'ev0_(constitution|change_ledger)_boot' | tail -n 2 | cut -c1-220 | tr '\n' ' ')"
if [ -z "$ev0" ]; then record C09_ev0_boot UNKNOWN "ingen ev0_constitution_boot/ev0_change_ledger_boot i siste 5000 loggrader (start api på nytt og kjør igjen)"
elif echo "$ev0" | grep -qiE 'unsigned|missing|invalid|broken|mismatch|not_pinned|failed'; then record C09_ev0_boot WARN "$ev0"
else record C09_ev0_boot PASS "$ev0"; fi

# C10: backup-ferskhet (D-370) og ukryptert stray-mappe
if [ -z "${JARVIS_BACKUP_DIR:-}" ]; then record C10_backup_freshness UNKNOWN "sett JARVIS_BACKUP_DIR til mappen nas-backup.sh skriver til"
elif [ ! -d "$JARVIS_BACKUP_DIR" ]; then record C10_backup_freshness FAIL "mappen $JARVIS_BACKUP_DIR finnes ikke"
else
  newest="$(find "$JARVIS_BACKUP_DIR" -maxdepth 2 -type f \( -name '*.age' -o -name 'manifest*.json' \) -printf '%T@\n' 2>/dev/null | sort -n | tail -n1)"
  if [ -z "$newest" ]; then record C10_backup_freshness FAIL "ingen krypterte backup-filer funnet"
  else
    age_h=$(( ( $(date +%s) - ${newest%.*} ) / 3600 ))
    stray=""; [ -d "$JARVIS_BACKUP_DIR/stray" ] && stray=" | UKRYPTERT stray/ finnes - slett/flytt"
    if [ "$age_h" -le 25 ] && [ -z "$stray" ]; then record C10_backup_freshness PASS "nyeste backup er $age_h t gammel"
    else record C10_backup_freshness WARN "nyeste backup $age_h t gammel (mål ≤ 25)$stray"; fi
  fi
fi

# C11: tabeller UTEN rad-nivå-sikkerhet må være nøyaktig de dokumenterte globale (RLS_EXEMPT i modules/core/test/remediation-2-schema-invariants.test.ts)
EXPECTED_NO_RLS="capabilities,evolution_change_ledger,github_rate_limit_state,owner_control_state,scheduler_state,schema_migrations,self_modification_requests,situation_domain_pauses,telegram_poll_state"
norls="$(psqlq "SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND NOT relrowsecurity")"
if [ -z "$(psqlq 'SELECT 1')" ]; then record C11_rls_tables UNKNOWN "fikk ikke kontakt med databasen"
elif [ "$norls" = "$EXPECTED_NO_RLS" ]; then record C11_rls_tables PASS "kun de 9 dokumenterte globale tabellene mangler RLS"
else record C11_rls_tables FAIL "avvik fra dokumenterte globale tabeller. Funnet: ${norls:-ingen} | Forventet: $EXPECTED_NO_RLS"; fi

# C12: containerherding (api/worker): ikke root, read-only rotfs, cap_drop ALL
hard=""
for s in api worker; do
  cid="$(dc ps -q "$s" 2>/dev/null | head -n1)"
  [ -n "$cid" ] || { hard="$hard $s:ukjent"; continue; }
  info="$(docker inspect -f '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}' "$cid" 2>/dev/null)"
  user="${info%%|*}"; rest="${info#*|}"; ro="${rest%%|*}"; caps="${rest#*|}"
  ok=1; { [ -n "$user" ] && [ "$user" != "root" ] && [ "$user" != "0" ]; } || ok=0; [ "$ro" = "true" ] || ok=0; echo "$caps" | grep -qi ALL || ok=0
  [ "$ok" = "1" ] && hard="$hard $s:ok" || hard="$hard $s:AVVIK($info)"
done
if echo "$hard" | grep -q "AVVIK"; then record C12_container_hardening FAIL "$hard"
elif echo "$hard" | grep -q "ukjent"; then record C12_container_hardening UNKNOWN "$hard"
else record C12_container_hardening PASS "$hard"; fi

# C13 (WP-OPS2a K5): backup-status fra backup-skriptets EGET statusskript (`nas-schedule.sh <mappe> status --json`): exit 3 forfalt = FAIL, 4 restore-verifisering / 5 off-site = WARN, exit 0 = PASS KUN når JSON-en har en gyldig exit_code som er lik exit-koden,
# alder og begge tilstandene er kjent, og restore-verifisering og off-site er `ok`. Samme WARN som H07 (nas-hf1-hf2-gate.sh, classify_backup) for restore=never_run|not_configured og offsite=not_configured|pending. Alt annet (ukjent/manglende felt, uenighet, uventet exit) = UNKNOWN.
# Kun koder og tall når skjermen og evidensfilen: JSON-en er ubetrodd data og leses med en lukket mal (tilstander fra faste lister, tall, årsakskoder uten settnavn) - aldri fritekst. Selve gaten leser ingenting fra backup-mappen i C13 (C10 gjør det).
NODE_BIN="${JARVIS_ACCEPTANCE_NODE_BIN:-node}"
BACKUP_STATUS_CMD="${JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD:-$ROOT/ops/backup/nas-schedule.sh}"
BACKUP_STATUS_TIMEOUT="${JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC:-120}"
[[ "$BACKUP_STATUS_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$BACKUP_STATUS_TIMEOUT" -ge 1 ] && [ "$BACKUP_STATUS_TIMEOUT" -le 900 ] || BACKUP_STATUS_TIMEOUT=120
# En test-seam kan gi PASS uten at noe ekte er målt: raden sier det (skjerm og evidensfil).
C13_NOTE=""
if [ -n "${JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD:-}${JARVIS_ACCEPTANCE_NODE_BIN:-}${JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC:-}" ]; then C13_NOTE=" (OVERSTYRT, kun test)"; fi
c13() { record C13_backup_status "$1" "$2$C13_NOTE"; }
# Mappen absolutiseres her: nas-schedule.sh bytter til repoets rot før den leser den, så en relativ sti ville pekt på en annen mappe enn C10 leste.
BACKUP_DIR_ABS=""
if [ -n "${JARVIS_BACKUP_DIR:-}" ]; then case "$JARVIS_BACKUP_DIR" in /*) BACKUP_DIR_ABS="$JARVIS_BACKUP_DIR";; *) BACKUP_DIR_ABS="$PWD/$JARVIS_BACKUP_DIR";; esac; fi
PARSE_BACKUP_STATUS='
let s = "";
process.stdin.on("data", (c) => { s += c; }).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { console.log("INVALID"); return; }
  if (typeof j !== "object" || j === null || Array.isArray(j)) { console.log("INVALID"); return; }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? String(Math.round(v * 10) / 10) : "?");
  const pick = (v, list) => (typeof v === "string" && list.includes(v) ? v : "?");
  const code = (r) => {
    if (typeof r !== "string") return null;
    const [a, b] = r.split(":");
    if (!/^[a-z][a-z0-9_.]{0,60}$/.test(a)) return null;
    return b !== undefined && /^[a-z_]{1,40}$/.test(b) ? a + ":" + b : a;
  };
  const reasons = (Array.isArray(j.reasons) ? j.reasons : []).map(code).filter((x) => x !== null).slice(0, 6).join(",");
  console.log(["OK", "ec=" + (Number.isInteger(j.exit_code) && j.exit_code >= 0 && j.exit_code <= 255 ? j.exit_code : "?"), "age_h=" + num(j.backup && j.backup.age_hours),
    "verify=" + pick(j.restore_verify && j.restore_verify.state, ["not_configured", "never_run", "ok", "failed"]),
    "offsite=" + pick(j.offsite && j.offsite.state, ["not_configured", "pending", "ok", "failed"]), "reasons=" + (reasons || "-")].join(" "));
});'
PARSED_RE='^OK ec=([0-9]{1,3}|\?) age_h=([0-9.]+|\?) verify=([a-z_?]+) offsite=([a-z_?]+) reasons=(.*)$'
if [ -z "${JARVIS_BACKUP_DIR:-}" ]; then c13 UNKNOWN "sett JARVIS_BACKUP_DIR til mappen nas-backup.sh skriver til"
elif ! command -v "$NODE_BIN" >/dev/null 2>&1; then c13 UNKNOWN "node finnes ikke på verten (status-kommandoen og tolkningen trenger node)"
else
  c13_t0="$(date +%s)"
  if command -v timeout >/dev/null 2>&1; then
    # -k 5: en kommando som ignorerer TERM får KILL 5 s etter fristen (exit 137), så den aldri holder gaten.
    status_json="$(timeout -k 5 "$BACKUP_STATUS_TIMEOUT" "$BACKUP_STATUS_CMD" "$BACKUP_DIR_ABS" status --json </dev/null 2>/dev/null)"; status_rc=$?
  else
    status_json="$("$BACKUP_STATUS_CMD" "$BACKUP_DIR_ABS" status --json </dev/null 2>/dev/null)"; status_rc=$?
  fi
  c13_elapsed=$(( $(date +%s) - c13_t0 ))
  parsed="$(printf '%s' "$status_json" | "$NODE_BIN" -e "$PARSE_BACKUP_STATUS" 2>/dev/null)"
  if [ "$status_rc" = "124" ] || { [ "$status_rc" = "137" ] && [ "$c13_elapsed" -ge "$BACKUP_STATUS_TIMEOUT" ]; }; then c13 UNKNOWN "tidsavbrudd etter ${BACKUP_STATUS_TIMEOUT} s (status-kommandoen svarte ikke)"
  elif ! [[ "$parsed" =~ $PARSED_RE ]]; then c13 UNKNOWN "status-JSON kunne ikke tolkes (exit $status_rc)"
  else
    ec="${BASH_REMATCH[1]}"; age="${BASH_REMATCH[2]}"; verify="${BASH_REMATCH[3]}"; offsite="${BASH_REMATCH[4]}"
    detail="exit=$status_rc age_h=$age verify=$verify offsite=$offsite reasons=${BASH_REMATCH[5]}"
    if [ "$ec" = "?" ]; then c13 UNKNOWN "status-JSON mangler gyldig exit_code (exit $status_rc) - ikke tolket som frisk: $detail"
    elif [ "$ec" != "$status_rc" ]; then c13 UNKNOWN "exit-koden ($status_rc) og status-JSON (exit_code $ec) er uenige"
    else
      case "$status_rc" in
        0)
          if [ "$age" = "?" ] || [ "$verify" = "?" ] || [ "$offsite" = "?" ]; then c13 UNKNOWN "ufullstendig status-JSON (alder, restore-tilstand eller off-site-tilstand er ukjent) - ikke tolket som frisk: $detail"
          elif [ "$verify" = "failed" ] || [ "$offsite" = "failed" ]; then c13 UNKNOWN "exit-koden (0) og status-JSON (failed) er uenige: $detail"
          elif [ "$verify" != "ok" ] || [ "$offsite" != "ok" ]; then c13 WARN "$detail - restore-verifisering eller off-site er ikke bekreftet (samme WARN som H07)"
          else c13 PASS "$detail"; fi;;
        3) c13 FAIL "$detail";;
        4|5) c13 WARN "$detail";;
        *) c13 UNKNOWN "uventet exit $status_rc: $detail";;
      esac
    fi
  fi
fi

# C14 (WP-OPS2a K5): vakthunden tikker. Raden `incident_producer_runs`/`watchdog` skrives av worker-broen KUN når JARVIS_INCIDENT_PRODUCERS_ENABLED=true; uten rad er svaret UNKNOWN (aldri PASS).
# PASS opptil 300 s siden siste tikk, WARN opptil 900 s, FAIL over det. Kun tall.
wd_age="$(psqlq "SELECT floor(extract(epoch FROM (now() - max(last_started_at))))::bigint FROM incident_producer_runs WHERE producer = 'watchdog'" | tr -d '[:space:]')"
if ! [[ "$wd_age" =~ ^-?[0-9]+$ ]]; then
  if [ -z "$(psqlq 'SELECT 1')" ]; then record C14_watchdog_alive UNKNOWN "fikk ikke kontakt med databasen"
  else record C14_watchdog_alive UNKNOWN "ingen vakthund-tikk registrert (incident-produsentene er AV, eller worker har aldri tikket)"; fi
elif [ "$wd_age" -lt -60 ]; then record C14_watchdog_alive UNKNOWN "siste tikk er datert ${wd_age#-} s frem i tid (klokkeavvik mellom worker og database) - alderen kan ikke bevises"
else
  [ "$wd_age" -lt 0 ] && wd_age=0
  if [ "$wd_age" -le 300 ]; then record C14_watchdog_alive PASS "siste vakthund-tikk for $wd_age s siden (grense 300 s)"
  elif [ "$wd_age" -le 900 ]; then record C14_watchdog_alive WARN "siste vakthund-tikk for $wd_age s siden (over 300 s, under 900 s)"
  else record C14_watchdog_alive FAIL "siste vakthund-tikk for $wd_age s siden (over 900 s) - worker står, henger eller er stoppet"; fi
fi

write_evidence() {
  echo "# UA-0 NAS-akseptanse - $STAMP"
  echo
  echo "Generert av \`ops/acceptance/nas-ua0-gate.sh\` (D-422). Ingen hemmeligheter; kun antall/navn/tilstand. PASS betyr at denne målingen var som forventet akkurat nå - ikke at en UA-port er lukket."
  echo
  echo "Sammendrag: PASS=$PASS WARN=$WARN UNKNOWN=$UNKNOWN FAIL=$FAIL"
  echo
  echo "| Sjekk | Status | Detalj |"
  echo "|---|---|---|"
  printf '%s\n' "${ROWS[@]}"
}
# Evidensfilen er best effort, men scriptet skal aldri PÅSTÅ at den ble skrevet når den ikke ble det. På NAS-en var `out/` eid av en annen bruker (root etter en
# tidligere sudo-kjøring): da feilet både chmod og skrivingen («Permission denied»), og scriptet skrev likevel «Evidens skrevet til». Utdataene på skjermen er alltid
# evidensen; filen er en kopi. Exit-koden styres fortsatt KUN av sjekkene.
evidence_ok=0
if mkdir -p "$OUT_DIR" 2>/dev/null; then
  chmod 700 "$OUT_DIR" 2>/dev/null || true
  if ( write_evidence > "$OUT_FILE" ) 2>/dev/null; then evidence_ok=1; fi
fi
echo
echo "Sammendrag: PASS=$PASS WARN=$WARN UNKNOWN=$UNKNOWN FAIL=$FAIL"
if [ "$evidence_ok" = "1" ]; then
  echo "Evidens skrevet til: $OUT_FILE"
else
  echo "ADVARSEL: evidensfilen ble IKKE skrevet ($OUT_DIR er ikke skrivbar for $(id -un)). Eies mappen av en annen bruker (for eksempel root etter en tidligere sudo-kjøring), rett den med: sudo chown -R $(id -un):$(id -gn) $OUT_DIR - eller sett JARVIS_ACCEPTANCE_OUT_DIR til en skrivbar mappe. Utdataene over er eneste evidens fra denne kjøringen." >&2
fi
[ "$FAIL" -eq 0 ]
