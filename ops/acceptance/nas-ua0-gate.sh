#!/usr/bin/env bash
# UA-0 NAS-akseptanse (D-422): ÉN kommando på NAS-en som samler EVIDENS for produksjonsportene i ett dokument - uten hemmeligheter.
#   ops/acceptance/nas-ua0-gate.sh                # kjør mot kjørende compose-stack (fra repoets rot på NAS)
#   JARVIS_ACCEPTANCE_DRY_RUN=1 ops/acceptance/nas-ua0-gate.sh   # skriv kun sjekklisten (ingen docker)
# Valgfritt miljø: JARVIS_BACKUP_DIR (mappen nas-backup.sh skriver til), JARVIS_COMPOSE_FILE, JARVIS_ACCEPTANCE_OUT_DIR (evidensmappe; standard ops/acceptance/out).
# Leser aldri .env og skriver aldri passord/tokens: Postgres nås via lokal socket i containeren (ingen passord), og kun antall/navn/tilstand rapporteres.
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

CHECKS=(C01_compose_services C02_migrations_applied C03_pgvector_hnsw C04_schema_features C05_api_health C06_local_model C07_chat_cost_24h C08_provider_failures_24h C09_ev0_boot C10_backup_freshness C11_rls_tables C12_container_hardening)

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
EXPECTED_NO_RLS="capabilities,evolution_change_ledger,evolution_usage_ledger,github_rate_limit_state,owner_control_state,scheduler_state,schema_migrations,self_modification_requests,situation_domain_pauses,telegram_poll_state"
norls="$(psqlq "SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace AND NOT relrowsecurity")"
if [ -z "$(psqlq 'SELECT 1')" ]; then record C11_rls_tables UNKNOWN "fikk ikke kontakt med databasen"
elif [ "$norls" = "$EXPECTED_NO_RLS" ]; then record C11_rls_tables PASS "kun de 10 dokumenterte globale tabellene mangler RLS"
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
