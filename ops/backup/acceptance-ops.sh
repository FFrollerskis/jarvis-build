#!/usr/bin/env bash
# WP-C2 (OPS-RUNTIME) akseptanse: beviser at PLANLAGT backup, OFF-SITE-kopi, RESTORE-verifisering og EKSTERN heartbeat faktisk virker - og MÅLER RTO/RPO.
# Uten hemmeligheter i utskriften (kun tilstander, tall og navn). Kjøres av eieren; ingenting her er verifisert før det er kjørt på de ekte maskinene.
#
#   ops/backup/acceptance-ops.sh nas   <backup-mappe>                                   # PÅ NAS-en (docker + .env; IKKE privatnøkkelen)
#   ops/backup/acceptance-ops.sh drill <backup-mappe> --identity <fil> [--from-offsite]  # PÅ maskinen med den PRIVATE age-nøkkelen (PC/offline-vert)
#   ops/backup/acceptance-ops.sh report <backup-mappe>                                  # kun les status (ingen kjøring, ingen endring)
#   JARVIS_ACCEPTANCE_DRY_RUN=1 ops/backup/acceptance-ops.sh nas|drill|report            # skriv kun sjekklisten (ingenting kjøres)
#
# nas:   tvinger frem ÉN planlagt backup (nøyaktig samme kodevei som cron-tikket), kontrollerer at settet er kryptert, at off-site-kopien finnes og stemmer
#        mot manifestet, at heartbeat ble mottatt (HTTP 2xx), at statuseksporten er lesbar for API-containeren, og regner ut RPO.
# drill: henter nyeste sett (lokalt, eller fra off-site med --from-offsite), dekrypterer manifestet med den private nøkkelen, restorer ALLE databaser til en
#        engangs-scratch-Postgres og sammenligner tabeller + eksakte radtall. Måler RTO (henting + restore) og RPO (alderen på settet du faktisk gjenopprettet).
#        Skriver restore-verify-report.json som kopieres til NAS-ens state-mappe, slik at selvdiagnosen der viser at restore er bevist.
# Valgfritt miljø: JARVIS_RTO_TARGET_MINUTES / JARVIS_RPO_TARGET_HOURS (eierens MÅL - uten dem vises tallene som INFO og sjekken er ikke bestått),
#                  JARVIS_ACCEPTANCE_OUT_DIR (evidensmappe; standard ops/acceptance/out, git-ignorert), JARVIS_COMPOSE_FILE.
# Exit: 0 = ALT bestått · 1 = minst én FAIL · 3 = ingen FAIL, men noe er ikke satt opp/ikke målt (NOT_CONFIGURED/UNKNOWN: IKKE lukket).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SCHED="$HERE/schedule.mjs"
MODE="${1:-}"
DIR="${2:-}"
[ $# -gt 0 ] && shift
[ $# -gt 0 ] && shift
IDENTITY=""
FROM_OFFSITE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --from-offsite) FROM_OFFSITE=1; shift ;;
    *) echo "ukjent argument: $1" >&2; exit 1 ;;
  esac
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${JARVIS_ACCEPTANCE_OUT_DIR:-$ROOT/ops/acceptance/out}"
OUT_FILE="$OUT_DIR/ops-acceptance-$MODE-$STAMP.md"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
PASS=0; FAIL=0; INCOMPLETE=0
ROWS=()

CHECKS_NAS=(O01_scheduled_backup O02_set_encrypted O03_offsite_copy O04_heartbeat_received O05_status_export O06_api_sees_status O07_api_uptime_heartbeat O08_rpo)
CHECKS_DRILL=(D01_restore_verify D02_rto D03_rpo D04_report_for_nas)
CHECKS_REPORT=(R01_status)

record() { # id status detail
  local id="$1" status="$2" detail="$3"
  case "$status" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; NOT_CONFIGURED|UNKNOWN) INCOMPLETE=$((INCOMPLETE+1));; esac
  ROWS+=("| $id | $status | ${detail//|//} |")
  printf '%-26s %-15s %s\n' "$id" "$status" "$detail"
}

# jget <fil> <punktum.separert.sti> -> verdi (tom hvis mangler). Kun node (finnes allerede der backup kjører).
jget() { node -e 'let v;try{v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(0)};for(const k of process.argv[2].split(".")){v=v==null?undefined:v[k]};process.stdout.write(v==null?"":String(v))' "$1" "$2"; }

case "$MODE" in
  nas) CHECKS=("${CHECKS_NAS[@]}") ;;
  drill) CHECKS=("${CHECKS_DRILL[@]}") ;;
  report) CHECKS=("${CHECKS_REPORT[@]}") ;;
  *) echo "bruk: acceptance-ops.sh nas|drill|report <backup-mappe> [--identity FIL] [--from-offsite]" >&2; exit 1 ;;
esac

if [ "${JARVIS_ACCEPTANCE_DRY_RUN:-0}" = "1" ]; then
  echo "TØRRKJØRING ($MODE) - sjekklisten (ingenting kjøres):"
  for c in "${CHECKS[@]}"; do echo "  $c"; done
  exit 0
fi

[ -n "$DIR" ] || { echo "bruk: acceptance-ops.sh $MODE <backup-mappe>" >&2; exit 1; }
[ -d "$DIR" ] || [ "$MODE" = "drill" ] || { echo "finner ikke backup-mappen: $DIR" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node finnes ikke" >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

now_s() { date -u +%s; }
# minutter siden et settnavn (jarvis-backup-YYYYMMDDTHHMMSSZ) ble tatt
set_age_minutes() { node -e 'const m=/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(process.argv[1]);if(!m)process.exit(0);const t=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);process.stdout.write(String(Math.round((Date.now()-t)/60000)))' "$1"; }

status_json() { # skriver status til $TMP/status.json (både for nas via wrapperen og for drill/report direkte)
  if [ "$MODE" = "nas" ]; then "$HERE/nas-schedule.sh" "$DIR" status --json > "$TMP/status.json" 2> "$TMP/status.err"
  else node "$SCHED" status --out "$DIR" --json > "$TMP/status.json" 2> "$TMP/status.err"; fi
  return 0
}

if [ "$MODE" = "nas" ]; then
  # O01: planlagt backup (tvunget) - samme kodevei som cron-tikket
  "$HERE/nas-schedule.sh" "$DIR" tick --force-backup --json --roles backup,offsite > "$TMP/tick.json" 2> "$TMP/tick.err"; rc=$?
  actions="$(jget "$TMP/tick.json" actions)"
  if [ "$rc" -eq 0 ] && [ "$(jget "$TMP/tick.json" outcome)" = "ok" ] && echo "$actions" | grep -q backup; then
    record O01_scheduled_backup PASS "tvunget planlagt tikk tok backup (sett: $(jget "$TMP/tick.json" newest_set), handlinger: $actions)"
  else
    record O01_scheduled_backup FAIL "tikket ga exit $rc, utfall '$(jget "$TMP/tick.json" outcome)' (feilet: $(jget "$TMP/tick.json" failed)); siste feillinje: $(tail -n1 "$TMP/tick.err" 2>/dev/null | cut -c1-200)"
  fi
  status_json

  # O02: nyeste sett er ferskt og KUN age-kryptert (ingen klartekst-dump, ingen ukjente filer)
  newest="$(jget "$TMP/status.json" backup.newest_set)"
  age_h="$(jget "$TMP/status.json" backup.age_hours)"
  if [ -z "$newest" ] || [ ! -d "$DIR/$newest" ]; then
    record O02_set_encrypted FAIL "fant ikke nyeste komplette sett i $DIR"
  else
    bad=""
    for f in "$DIR/$newest"/*.age; do
      [ -f "$f" ] || continue
      [ "$(head -c 21 "$f")" = "age-encryption.org/v1" ] || bad="$bad $(basename "$f")"
    done
    stray="$(find "$DIR/$newest" -maxdepth 1 -type f ! -name '*.age' ! -name manifest.json ! -name SHA256SUMS -printf '%f ' 2>/dev/null)"
    fresh="$(node -e 'process.stdout.write(Number(process.argv[1])<0.25?"1":"0")' "${age_h:-99}")"
    if [ -n "$bad" ]; then record O02_set_encrypted FAIL "filer uten age-header (klartekst?):$bad"
    elif [ -n "$stray" ]; then record O02_set_encrypted FAIL "uventede filer i settet: $stray"
    elif [ "$fresh" != "1" ]; then record O02_set_encrypted FAIL "settet er ikke ferskt (${age_h:-?} t) - ble det tatt av dette tikket?"
    else record O02_set_encrypted PASS "$newest: alle .age-filer har age-header, ingen klartekst, alder ${age_h} t"; fi
  fi

  # O03: off-site-kopien finnes og stemmer mot manifestet (rclone/rsync/lokal sti - eierens valg)
  "$HERE/nas-schedule.sh" "$DIR" offsite-check > "$TMP/offsite.json" 2> "$TMP/offsite.err"; rc=$?
  case "$rc" in
    0) record O03_offsite_copy PASS "$(jget "$TMP/offsite.json" adapter): nyeste sett finnes og stemmer (verifisering: $(jget "$TMP/offsite.json" verification), $(jget "$TMP/offsite.json" files) filer, $(jget "$TMP/offsite.json" bytes) byte)" ;;
    6) record O03_offsite_copy NOT_CONFIGURED "ingen off-site-adapter er satt opp (JARVIS_BACKUP_OFFSITE_*) - BLOCKED_EXTERNAL: eieren velger mål, se runbook §6.3" ;;
    *) record O03_offsite_copy FAIL "exit $rc: $(jget "$TMP/offsite.json" error_code) - $(jget "$TMP/offsite.json" error)" ;;
  esac

  # O04: heartbeat ble MOTTATT (HTTP 2xx) av den eksterne monitoren. At den vises i monitorens dashbord bekrefter du selv.
  hb_cfg="$(jget "$TMP/status.json" heartbeat.configured)"; hb_ok="$(jget "$TMP/status.json" heartbeat.last_ping_ok)"; hb_kind="$(jget "$TMP/status.json" heartbeat.last_ping_kind)"
  if [ "$hb_cfg" != "true" ]; then record O04_heartbeat_received NOT_CONFIGURED "JARVIS_BACKUP_HEARTBEAT_URL er ikke satt - ingen dead-man's switch (runbook §6.4)"
  elif [ "$hb_ok" = "true" ] && [ "$hb_kind" = "success" ]; then record O04_heartbeat_received PASS "siste ping ($hb_kind) ble besvart med 2xx. EIER: bekreft at den vises i monitorens dashbord (og at stillhet varsler)"
  else record O04_heartbeat_received FAIL "siste ping var '$hb_kind' og ok='$hb_ok' (feilkode: $(jget "$TMP/status.json" heartbeat.last_error_code))"; fi

  # O05: statuseksporten (den API-containeren monterer :ro) finnes, er lesbar for andre og fersk
  ex_cfg="$(jget "$TMP/status.json" export.configured)"
  if [ "$ex_cfg" != "true" ]; then record O05_status_export NOT_CONFIGURED "JARVIS_BACKUP_STATUS_EXPORT_DIR er ikke satt - selvdiagnosen får ingen backup-status (runbook §6.5)"
  elif [ "$(jget "$TMP/status.json" export.present)" != "true" ]; then record O05_status_export FAIL "eksportfilen finnes ikke"
  elif [ "$(jget "$TMP/status.json" export.world_readable)" != "true" ]; then record O05_status_export FAIL "eksportfilen er ikke lesbar for andre (modus $(jget "$TMP/status.json" export.mode)) - API-containeren (uid 1000) kan ikke lese den"
  else record O05_status_export PASS "eksport finnes, modus $(jget "$TMP/status.json" export.mode), $(jget "$TMP/status.json" export.age_minutes) min gammel"; fi

  # O06: API-containeren ser filen (monteringen virker)
  if ! command -v docker >/dev/null 2>&1 || [ ! -f "$COMPOSE_FILE" ]; then record O06_api_sees_status UNKNOWN "docker/compose-fil ikke tilgjengelig her"
  else
    seen="$(docker compose -f "$COMPOSE_FILE" exec -T api sh -c 'if [ -z "$JARVIS_BACKUP_STATUS_FILE" ]; then echo UNSET; elif [ -r "$JARVIS_BACKUP_STATUS_FILE" ]; then echo READABLE; else echo MISSING; fi' 2>/dev/null | tr -d '\r')"
    case "$seen" in
      READABLE) record O06_api_sees_status PASS "api-containeren kan lese JARVIS_BACKUP_STATUS_FILE" ;;
      UNSET) record O06_api_sees_status NOT_CONFIGURED "JARVIS_BACKUP_STATUS_FILE er ikke satt i api-containeren (compose-override, runbook §6.5)" ;;
      MISSING) record O06_api_sees_status FAIL "JARVIS_BACKUP_STATUS_FILE er satt, men filen er ikke lesbar i containeren (mount/rettigheter)" ;;
      *) record O06_api_sees_status UNKNOWN "fikk ikke svar fra api-containeren" ;;
    esac

    # O07: API-oppetids-heartbeat (JARVIS_UPTIME_HEARTBEAT_URL) kjører
    logs="$(docker compose -f "$COMPOSE_FILE" logs --no-log-prefix --tail 4000 api 2>/dev/null)"
    if echo "$logs" | grep -q '"uptime_heartbeat_started"'; then
      if echo "$logs" | grep '"uptime_heartbeat_' | tail -n1 | grep -qE 'selfcheck_failed|ping_failed|config_invalid'; then record O07_api_uptime_heartbeat FAIL "heartbeat er startet, men siste hendelse er en feil: $(echo "$logs" | grep '"uptime_heartbeat_' | tail -n1 | cut -c1-160)"
      else record O07_api_uptime_heartbeat PASS "uptime_heartbeat_started i api-loggen og ingen feil etterpå. EIER: bekreft i monitoren at pingene kommer, og at å stoppe api gir varsel"; fi
    elif echo "$logs" | grep -q '"uptime_heartbeat_config_invalid"'; then record O07_api_uptime_heartbeat FAIL "ugyldig JARVIS_UPTIME_HEARTBEAT_*-konfig (se api-loggen)"
    else record O07_api_uptime_heartbeat NOT_CONFIGURED "JARVIS_UPTIME_HEARTBEAT_URL er ikke satt (eller api er ikke startet på nytt etter at den ble satt)"; fi
  fi

  # O08: RPO (alder på nyeste sett nå + verste tilfelle = intervall + tikk-periode) mot eierens mål
  interval="$(jget "$TMP/status.json" config.backup_interval_hours)"
  worst="$(node -e 'process.stdout.write(String(Math.round((Number(process.argv[1])+0.25)*100)/100))' "${interval:-24}")"
  if [ -n "${JARVIS_RPO_TARGET_HOURS:-}" ]; then
    ok="$(node -e 'process.stdout.write(Number(process.argv[1])<=Number(process.argv[2])?"1":"0")' "$worst" "$JARVIS_RPO_TARGET_HOURS")"
    if [ "$ok" = "1" ]; then record O08_rpo PASS "verste tilfelle ≈ $worst t (intervall ${interval} t + 15 min tikk) ≤ mål ${JARVIS_RPO_TARGET_HOURS} t"
    else record O08_rpo FAIL "verste tilfelle ≈ $worst t (intervall ${interval} t + 15 min tikk) > mål ${JARVIS_RPO_TARGET_HOURS} t - senk JARVIS_BACKUP_INTERVAL_HOURS"; fi
  else
    record O08_rpo UNKNOWN "INFO: verste tilfelle ≈ $worst t (intervall ${interval} t + 15 min tikk); eierens RPO-mål er ikke satt (JARVIS_RPO_TARGET_HOURS) - fyll inn i runbook §6.7"
  fi
fi

if [ "$MODE" = "drill" ]; then
  if [ -z "$IDENTITY" ] || [ ! -f "$IDENTITY" ]; then record D01_restore_verify FAIL "krever --identity <privat age-nøkkelfil> (finnes ikke på NAS-en)"
  else
    export JARVIS_BACKUP_VERIFY_IDENTITY_FILE="$IDENTITY"
    extra=()
    if [ "$FROM_OFFSITE" = "1" ]; then extra=(--verify-source offsite); fi
    mkdir -p "$DIR"
    start_s="$(now_s)"
    node "$SCHED" tick --out "$DIR" --roles verify --force-verify --json "${extra[@]+"${extra[@]}"}" > "$TMP/tick.json" 2> "$TMP/tick.err"; rc=$?
    status_json
    vstate="$(jget "$TMP/status.json" restore_verify.state)"
    if [ "$rc" -eq 0 ] && [ "$vstate" = "ok" ]; then
      record D01_restore_verify PASS "alle databaser restoret til scratch og lik manifestet: $(jget "$TMP/status.json" restore_verify.tables) tabeller, $(jget "$TMP/status.json" restore_verify.rows) rader (sett $(jget "$TMP/status.json" restore_verify.last_set), kilde $(jget "$TMP/status.json" restore_verify.source))"
    else
      record D01_restore_verify FAIL "exit $rc, tilstand '$vstate', feilkode '$(jget "$TMP/status.json" restore_verify.last_error_code)'. Siste feillinje: $(tail -n1 "$TMP/tick.err" 2>/dev/null | cut -c1-200)"
    fi

    fetch_s="$(jget "$TMP/status.json" restore_verify.fetch_duration_s)"; restore_s="$(jget "$TMP/status.json" restore_verify.duration_s)"
    if [ -n "$restore_s" ]; then
      rto_min="$(node -e 'process.stdout.write(String(Math.round(((Number(process.argv[1]||0)+Number(process.argv[2]))/60)*10)/10))' "${fetch_s:-0}" "$restore_s")"
      msg="MÅLT RTO (scratch) = $rto_min min (henting ${fetch_s:-0} s + restore/verifisering ${restore_s} s). Dekker IKKE: start av stacken, repeke API/klienter, menneskelig tid - legg til i runbook §6.6"
      if [ -n "${JARVIS_RTO_TARGET_MINUTES:-}" ]; then
        ok="$(node -e 'process.stdout.write(Number(process.argv[1])<=Number(process.argv[2])?"1":"0")' "$rto_min" "$JARVIS_RTO_TARGET_MINUTES")"
        if [ "$ok" = "1" ]; then record D02_rto PASS "$msg; mål ${JARVIS_RTO_TARGET_MINUTES} min oppfylt"; else record D02_rto FAIL "$msg; mål ${JARVIS_RTO_TARGET_MINUTES} min IKKE oppfylt"; fi
      else record D02_rto UNKNOWN "$msg; eierens RTO-mål er ikke satt (JARVIS_RTO_TARGET_MINUTES)"; fi
    else record D02_rto FAIL "ingen målt restore-tid (verifiseringen kjørte ikke)"; fi

    last_set="$(jget "$TMP/status.json" restore_verify.last_set)"
    age_min="$(set_age_minutes "$last_set")"
    if [ -n "$age_min" ]; then
      rpo_h="$(node -e 'process.stdout.write(String(Math.round((Number(process.argv[1])/60)*10)/10))' "$age_min")"
      msg="MÅLT RPO = $rpo_h t (alderen på settet du faktisk gjenopprettet: $last_set)"
      if [ -n "${JARVIS_RPO_TARGET_HOURS:-}" ]; then
        ok="$(node -e 'process.stdout.write(Number(process.argv[1])<=Number(process.argv[2])?"1":"0")' "$rpo_h" "$JARVIS_RPO_TARGET_HOURS")"
        if [ "$ok" = "1" ]; then record D03_rpo PASS "$msg; mål ${JARVIS_RPO_TARGET_HOURS} t oppfylt"; else record D03_rpo FAIL "$msg; mål ${JARVIS_RPO_TARGET_HOURS} t IKKE oppfylt"; fi
      else record D03_rpo UNKNOWN "$msg; eierens RPO-mål er ikke satt (JARVIS_RPO_TARGET_HOURS)"; fi
    else record D03_rpo FAIL "fant ikke settnavn å måle RPO mot"; fi

    if [ -f "$DIR/restore-verify-report.json" ]; then
      record D04_report_for_nas PASS "kopier $DIR/restore-verify-report.json til NAS-ens state-mappe (standard: backup-mappen), f.eks. scp/rsync - da viser selvdiagnosen der at restore er bevist"
    else record D04_report_for_nas FAIL "restore-verify-report.json ble ikke skrevet i $DIR"; fi
    echo "(drill brukte $(( $(now_s) - start_s )) s totalt)"
  fi
fi

if [ "$MODE" = "report" ]; then
  status_json
  if [ -s "$TMP/status.json" ]; then
    record R01_status PASS "ok=$(jget "$TMP/status.json" ok) nyeste sett $(jget "$TMP/status.json" backup.newest_set) (${age_h:-$(jget "$TMP/status.json" backup.age_hours)} t), off-site $(jget "$TMP/status.json" offsite.state), restore-verify $(jget "$TMP/status.json" restore_verify.state), heartbeat konfigurert=$(jget "$TMP/status.json" heartbeat.configured)"
  else record R01_status FAIL "fikk ikke lest status: $(tail -n1 "$TMP/status.err" 2>/dev/null | cut -c1-200)"; fi
fi

write_evidence() {
  echo "# Drift-akseptanse ($MODE) - $STAMP"
  echo
  echo "Generert av \`ops/backup/acceptance-ops.sh\` (WP-C2). Ingen hemmeligheter; kun tilstander, tall og navn. PASS betyr at DENNE målingen var som forventet akkurat nå - ikke at OPS-RUNTIME er lukket."
  echo
  echo "Sammendrag: PASS=$PASS FAIL=$FAIL IKKE-SATT-OPP/UKJENT=$INCOMPLETE"
  echo
  echo "| Sjekk | Status | Detalj |"
  echo "|---|---|---|"
  printf '%s\n' "${ROWS[@]+"${ROWS[@]}"}"
}
# Samme ærlighet som nas-ua0-gate.sh: aldri påstå at evidensfilen ble skrevet når den ikke ble det. Skjermutskriften er alltid evidensen; filen er en kopi.
evidence_ok=0
if mkdir -p "$OUT_DIR" 2>/dev/null; then
  chmod 700 "$OUT_DIR" 2>/dev/null || true
  if ( write_evidence > "$OUT_FILE" ) 2>/dev/null; then evidence_ok=1; fi
fi
echo
echo "Sammendrag: PASS=$PASS FAIL=$FAIL IKKE-SATT-OPP/UKJENT=$INCOMPLETE"
if [ "$evidence_ok" = "1" ]; then echo "Evidens skrevet til: $OUT_FILE"
else echo "ADVARSEL: evidensfilen ble IKKE skrevet ($OUT_DIR er ikke skrivbar for $(id -un)). Skjermutskriften over er eneste evidens fra denne kjøringen." >&2; fi
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$INCOMPLETE" -gt 0 ]; then echo "Ufullstendig: noe er ikke satt opp eller ikke målt (se NOT_CONFIGURED/UNKNOWN). OPS-RUNTIME er IKKE lukket." >&2; exit 3; fi
exit 0
