#!/usr/bin/env bash
# WP-C1 vertsside job-runner: AKSEPTANSE PÅ VERTEN (NAS). Beviser de D-32-portene som krever EKTE Docker/nettverk/systemd og som ikke kan
# bevises i repoets tester (disse bruker en fake docker). Kjøres av EIER på NAS-en, fra repoets rot:
#
#   ACCEPTANCE_REPO=<owner/repo> ops/job-runner/acceptance.sh [--with-restart] [--with-ttl] [--dry-run]
#
#   ACCEPTANCE_REPO     PÅKREVD (unntatt --dry-run): et SANDBOX-/test-repo som står i runner.allowed_repos. Aldri produksjonsrepoet:
#                       publiseringssteget pusher en ekte branch `jarvis/accept-<tid>` dit (blast radius, D-41). Slettes manuelt etterpå.
#   --with-restart      sender SIGKILL til jarvis-job-runner og restarter (krever root): bevis for reclaim etter krasj (D-32 port 12).
#   --with-ttl          venter til en jobb passerer runner.max_job_lifetime_s (bør være lav, f.eks. 60) og ser at den fjernes av TTL-rydderen.
#   --dry-run           skriver kun sjekklisten (ingen docker, ingen nettverk).
#   Valgfritt: GH_TOKEN (kun LES av sandbox-repoet) for å verifisere den pushede branchen via GitHub API; ACCEPT_LIVE_CLAUDE=1 + ANTHROPIC_API_KEY
#   for en liten ekte Claude Code-kjøring (beviser containeren -> proxy -> api.anthropic.com); JARVIS_JOB_RUNNER_CONFIG (standard /etc/jarvis/job-runner.json);
#   ACCEPTANCE_OUT_DIR (standard ops/acceptance/out, git-ignorert).
#
# Krever: bash, curl (>= 7.55), node (>= 22), docker. Brukeren må kunne lese tokenfilen og skrive til socketen (gruppen jarvis-job-clients) og bruke docker (root eller
# docker-gruppen). Skriver ALDRI hemmeligheter (token-verdier, PAT-innhold, API-nøkler): bearer-tokenet sendes via en 0600-headerfil (aldri i argv), og
# kun modus/eier/navn/statuskoder rapporteres. Exit 1 hvis minst én sjekk er FAIL; SKIP/MANUELL er IKKE bestått.
# Ærlighet: PASS betyr kun at DENNE målingen var som forventet akkurat nå, på akkurat denne verten.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONFIG="${JARVIS_JOB_RUNNER_CONFIG:-/etc/jarvis/job-runner.json}"
OUT_DIR="${ACCEPTANCE_OUT_DIR:-$ROOT/ops/acceptance/out}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/job-runner-acceptance-$STAMP.md"
REPO="${ACCEPTANCE_REPO:-}"
WITH_RESTART=0; WITH_TTL=0; DRY=0
PASS=0; FAIL=0; SKIP=0; MANUAL=0
ROWS=()
CREATED_JOBS=()
WORK=""
HTTP_CODE=""; EXEC_CODE=""; EXEC_OUT=""; EXEC_ERR=""; JOB_ID=""; CONTAINER=""

# D-32-portene (21) og sjekkene som bevise dem på verten. Tabellen i docs/runbooks/JOB_RUNNER.md kobler hver port til repo-test OG denne sjekken.
CHECKLIST=(
  "J01_filrettigheter            (port 4, 10)  config root-eid, tokenfil/PAT uten tilgang for andre, socket 0660, kataloger private"
  "J02_helse                     (--)          API svarer med riktig token; feil token gir 401"
  "J03_container_per_jobb        (port 1)      én container per jobb (navn/merkelapp), borte etter DELETE"
  "J04_docker_inspect            (2,3,4,5,6,7,8,9,10) privileged=false, read-only rootfs, cap-drop ALL, no-new-privileges, ikke-root, minne/CPU/PID, kun jobbnettverk, kun /work montert, ingen docker.sock"
  "J05_inne_i_containeren        (3,4,5,6,7,10) uid != 0, CapEff=0, ingen docker.sock, rootfs skrivebeskyttet, tmpfs noexec, ingen vertsmapper, ingen hemmelighets-env"
  "J06_ressursgrenser            (8)           minnegrense (OOM), PID-grense, tidsavbrudd dreper containeren"
  "J07_nettverk_deny_by_default  (9)           ingen direkte rute ut, vertstjenester utilgjengelige, proxy: github OK, fremmed/privat/metadata nektet, kun CONNECT, jobb-containere når ikke hverandre"
  "J08_kansellering              (11)          DELETE midt i en kjørende exec dreper containeren umiddelbart"
  "J09_reclaim_etter_krasj       (12)          [--with-restart] SIGKILL på runner -> ved oppstart fjernes rest-containere og -kataloger"
  "J10_ttl                       (8)           [--with-ttl] jobb fjernes av TTL-rydderen"
  "J11_ende_til_ende_publish     (14,15,16)    jobb -> commit i container -> publish -> branch jarvis/accept-... i sandbox-repoet; main/nektede stier/ingen endringer avvist"
  "J12_logger_uten_hemmeligheter (10,20)       journal for begge tjenester inneholder ingen token/PAT; gitleaks hvis tilgjengelig"
  "J13_live_claude               (14)          [ACCEPT_LIVE_CLAUDE=1] ekte Claude Code -p fra containeren via proxyen"
  "M01_github_beskyttelse        (16,17,18)    MANUELL: branch protection på main, PAT-rettigheter (kun ett repo, ingen admin), PR krever menneskelig merge"
)

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
for arg in "$@"; do
  case "$arg" in
    --with-restart) WITH_RESTART=1 ;;
    --with-ttl) WITH_TTL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ukjent argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

record() { # id status detail
  local id="$1" status="$2" detail="$3"
  case "$status" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; SKIP) SKIP=$((SKIP+1));; MANUELL) MANUAL=$((MANUAL+1));; esac
  ROWS+=("| $id | $status | ${detail//|//} |")
  printf '%-30s %-8s %s\n' "$id" "$status" "$detail"
}

# --- små hjelpere (testes isolert via ACCEPTANCE_SOURCE_ONLY=1) ---------------------------------------------------------------------------
# Leser én nøkkel (punktum-sti) fra JSON på stdin. Tom streng hvis den mangler.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){v=v==null?undefined:v[k]}console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{console.log("")}})' "$1"; }

# api METHOD PATH [JSON-BODY]  ->  $HTTP_CODE og $WORK/resp.json. Bearer-tokenet ligger i en 0600-headerfil (curl -H @fil), aldri i argv.
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS --max-time "${API_MAX_TIME:-1200}" --unix-socket "$SOCKET" -X "$method" -H "@$WORK/auth.hdr" -o "$WORK/resp.json" -w '%{http_code}')
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  HTTP_CODE="$(curl "${args[@]}" "http://localhost$path" 2>"$WORK/curl.err")" || HTTP_CODE="000"
}
resp_get() { jget "$1" < "$WORK/resp.json"; }

create_job() { # [env-json]  ->  $JOB_ID, $CONTAINER (returnerer 1 ved feil)
  local body
  body="$(node -e 'const o={repo:process.argv[1],task_id:"accept-"+process.argv[2]};if(process.argv[3])o.env=JSON.parse(process.argv[3]);process.stdout.write(JSON.stringify(o))' "$REPO" "$STAMP" "${1:-}")"
  api POST /v1/jobs "$body"
  if [ "$HTTP_CODE" != "201" ]; then JOB_ID=""; CONTAINER=""; return 1; fi
  JOB_ID="$(resp_get job_id)"
  CONTAINER="jarvis-job-$JOB_ID"
  CREATED_JOBS+=("$JOB_ID")
}

delete_job() { api DELETE "/v1/jobs/$1"; }

# cexec TIMEOUT_MS ARGV...  ->  $EXEC_CODE, $EXEC_OUT, $EXEC_ERR (kjører i $JOB_ID)
cexec() {
  local t="$1"; shift
  local body
  body="$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),timeout_ms:Number(process.argv[1])}))' "$t" "$@")"
  api POST "/v1/jobs/$JOB_ID/exec" "$body"
  if [ "$HTTP_CODE" = "200" ]; then EXEC_CODE="$(resp_get code)"; EXEC_OUT="$(resp_get stdout)"; EXEC_ERR="$(resp_get stderr)"; else EXEC_CODE="http$HTTP_CODE"; EXEC_OUT=""; EXEC_ERR="$(resp_get error)"; fi
}

container_exists() { docker ps -a --filter "name=^$1\$" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

wait_gone() { # container-navn, maks sekunder
  local i
  for ((i=0; i<$2*5; i++)); do container_exists "$1" || return 0; sleep 0.2; done
  return 1
}

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    for id in "${CREATED_JOBS[@]:-}"; do [ -n "$id" ] && api DELETE "/v1/jobs/$id" >/dev/null 2>&1 || true; done
    rm -rf "$WORK"
  fi
}

# Leser policy fra konfigfilen (ingen eval: node skriver ÉN verdi per linje i fast rekkefølge).
load_policy() {
  mapfile -t POL < <(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const r = c.runner || {}, p = c.egress_proxy || {};
    const out = [r.socket_path, r.token_file, r.network, r.image, r.user || "10001:10001", r.memory || "1g", r.cpus || "1.0", r.pids_limit || 256,
      r.base_dir || "/var/lib/jarvis-job-runner/jobs", p.listen_host || "", p.listen_port || 3128, r.max_job_lifetime_s || 3600,
      (r.allowed_repos || []).join(","), Object.values(r.git_credentials || {}).map((x) => x.token_file).join(","), r.branch_prefix || "jarvis/", r.socket_group || ""];
    console.log(out.map((v) => String(v)).join("\n"));
  ' "$CONFIG") || return 1
  SOCKET="${POL[0]}"; TOKEN_FILE="${POL[1]}"; NETWORK="${POL[2]}"; IMAGE="${POL[3]}"; USER_SPEC="${POL[4]}"; MEMORY="${POL[5]}"; CPUS="${POL[6]}"; PIDS="${POL[7]}"
  BASE_DIR="${POL[8]}"; GATEWAY="${POL[9]}"; PROXY_PORT="${POL[10]}"; LIFETIME="${POL[11]}"; ALLOWED="${POL[12]}"; PAT_FILES="${POL[13]}"; PREFIX="${POL[14]}"; SOCKET_GROUP="${POL[15]}"
  CONTAINER_UID="${USER_SPEC%%:*}"
}

mode_of() { stat -c '%a' "$1" 2>/dev/null; }
owner_of() { stat -c '%U' "$1" 2>/dev/null; }
group_of() { stat -c '%G' "$1" 2>/dev/null; }
# true hvis oktal modus $1 har NOEN av bitene i oktal maske $2
has_bits() { (( (8#$1 & 8#$2) != 0 )); }

# ============================= sjekkene ===================================================================================================
check_J01() {
  local problems=() m
  m="$(mode_of "$CONFIG")"
  [ "$(owner_of "$CONFIG")" = "root" ] || problems+=("config ikke eid av root")
  has_bits "${m:-777}" 022 && problems+=("config skrivbar for gruppe/andre ($m)")
  m="$(mode_of "$TOKEN_FILE")"
  [ -n "$m" ] || problems+=("tokenfil mangler")
  has_bits "${m:-777}" 007 && problems+=("tokenfil tilgjengelig for andre ($m)")
  has_bits "${m:-777}" 137 && problems+=("tokenfil har for åpne rettigheter ($m)")
  [ -S "$SOCKET" ] || problems+=("socket mangler")
  m="$(mode_of "$SOCKET")"
  [ "$m" = "660" ] || problems+=("socket har modus ${m:-?}, forventet 660")
  m="$(mode_of "$(dirname "$SOCKET")")"
  [ "$m" = "750" ] || problems+=("socket-katalogen har modus ${m:-?}, forventet 750")
  if [ -d "$BASE_DIR" ]; then
    m="$(mode_of "$BASE_DIR")"; [ "$m" = "700" ] || problems+=("base_dir modus ${m:-?}, forventet 700")
  else
    problems+=("base_dir ikke lesbar for denne brukeren (kjør som root for å verifisere)")
  fi
  local pat
  IFS=',' read -ra pats <<<"$PAT_FILES"
  for pat in "${pats[@]}"; do
    [ -n "$pat" ] || continue
    m="$(mode_of "$pat")"
    if [ -z "$m" ]; then problems+=("PAT-fil ikke synlig/mangler"); continue; fi
    has_bits "$m" 077 && problems+=("PAT-fil har tilgang for gruppe/andre ($m): worker skal aldri kunne lese den")
  done
  if [ "${#problems[@]}" -eq 0 ]; then record J01_filrettigheter PASS "config/token/PAT/socket/kataloger har riktige eiere og moduser"; else record J01_filrettigheter FAIL "${problems[*]}"; fi
}

check_J02() {
  api GET /v1/health
  local code_ok="$HTTP_CODE" status; status="$(resp_get status)"
  printf 'Authorization: Bearer feil-token-feil-token-feil-token-xx\n' > "$WORK/bad.hdr"
  local bad; bad="$(curl -sS --unix-socket "$SOCKET" -H "@$WORK/bad.hdr" -o /dev/null -w '%{http_code}' http://localhost/v1/health 2>/dev/null || echo 000)"
  if [ "$code_ok" = "200" ] && [ "$status" = "ok" ] && [ "$bad" = "401" ]; then record J02_helse PASS "health 200/ok med riktig token; feil token gir 401"; else record J02_helse FAIL "health=$code_ok status=$status feil-token=$bad"; fi
}

check_J03() {
  create_job || { record J03_container_per_jobb FAIL "kunne ikke opprette jobb (http=$HTTP_CODE $(resp_get error))"; return; }
  local a="$CONTAINER" aid="$JOB_ID"
  create_job || { record J03_container_per_jobb FAIL "kunne ikke opprette jobb nr. 2 (http=$HTTP_CODE $(resp_get error))"; return; }
  local b="$CONTAINER" bid="$JOB_ID"
  local labelled; labelled="$(docker ps -a --filter label=jarvis.role=job --format '{{.Names}}' | grep -cx -e "$a" -e "$b")"
  local up_a; up_a="$(docker inspect --format '{{.State.Running}}' "$a" 2>/dev/null)"
  delete_job "$aid"; delete_job "$bid"
  if wait_gone "$a" 5 && wait_gone "$b" 5 && [ "$labelled" = "2" ] && [ "$up_a" = "true" ] && [ "$a" != "$b" ]; then
    record J03_container_per_jobb PASS "to jobber = to separate, kjørende containere merket jarvis.role=job; begge borte etter DELETE"
  else
    record J03_container_per_jobb FAIL "merkede=$labelled kjører=$up_a gone-a=$(container_exists "$a" && echo nei || echo ja) gone-b=$(container_exists "$b" && echo nei || echo ja)"
  fi
}

check_J04() {
  create_job '{"ANTHROPIC_API_KEY":"akseptanse-dummy-ikke-en-ekte-nokkel"}' || { record J04_docker_inspect FAIL "kunne ikke opprette jobb (http=$HTTP_CODE)"; return; }
  local json; json="$(docker inspect "$CONTAINER" 2>/dev/null)"
  local verdict
  verdict="$(printf '%s' "$json" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const [c] = JSON.parse(s), h = c.HostConfig, cfg = c.Config, bad = [];
      const [, memory, cpus, pids, network, user] = process.argv;
      const bytes = (v) => { const m = /^(\d+)([kKmMgG]?)$/.exec(v); return Number(m[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]); };
      if (h.Privileged !== false) bad.push("privileged");
      if (h.ReadonlyRootfs !== true) bad.push("rootfs ikke read-only");
      if (!(h.CapDrop || []).map((x) => String(x).toUpperCase()).includes("ALL")) bad.push("cap-drop ALL mangler");
      if ((h.CapAdd || []).length) bad.push("cap-add: " + h.CapAdd.join(","));
      if (!(h.SecurityOpt || []).some((x) => /^no-new-privileges(:true)?$/.test(x))) bad.push("no-new-privileges mangler");
      if (h.Memory !== bytes(memory)) bad.push("minne " + h.Memory + " != " + bytes(memory));
      if (h.MemorySwap !== h.Memory) bad.push("swap tillatt");
      if (h.PidsLimit !== Number(pids)) bad.push("pids-limit " + h.PidsLimit);
      if (h.NanoCpus !== Math.round(Number(cpus) * 1e9)) bad.push("cpus " + h.NanoCpus);
      if (h.NetworkMode !== network) bad.push("nettverk " + h.NetworkMode);
      if (h.PidMode || h.UTSMode || h.UsernsMode) bad.push("delt pid/uts/userns");
      if (/^(host|container:)/.test(h.IpcMode || "")) bad.push("ipc " + h.IpcMode); // daemon-standarden (private/shareable) er ufarlig; kun host/container: deler navnerom
      if ((h.Devices || []).length) bad.push("devices");
      if ((h.Binds || []).length) bad.push("binds: " + h.Binds.length);
      if (cfg.User !== user) bad.push("bruker " + cfg.User);
      const mounts = (c.Mounts || []).filter((m) => m.Type !== "tmpfs"); // tmpfs (/tmp, /home/job) er forventet; kun bind/volume skal telles
      if (mounts.length !== 1 || mounts[0].Destination !== "/work" || mounts[0].Type !== "bind" || mounts[0].RW !== true) bad.push("mounts: " + mounts.map((m) => m.Destination).join(","));
      if (mounts.some((m) => /docker\.sock/.test(m.Source || ""))) bad.push("docker.sock montert");
      const names = (cfg.Env || []).map((e) => e.split("=")[0]);
      const forbidden = names.filter((n) => /^(GITHUB_TOKEN|GH_TOKEN|JARVIS_GIT|JARVIS_GITHUB|GIT_ASKPASS|SSH_AUTH_SOCK|INFISICAL|POSTGRES|PG|JARVIS_DB|NEXTAUTH|LANGFUSE|DOCKER_)/.test(n));
      if (forbidden.length) bad.push("forbudte env: " + forbidden.join(","));
      if (cfg.Labels["jarvis.role"] !== "job") bad.push("merkelapp jarvis.role");
      console.log(bad.length ? "FAIL " + bad.join("; ") : "PASS ok");
    });' "$MEMORY" "$CPUS" "$PIDS" "$NETWORK" "$USER_SPEC" 2>&1)"
  if [ "${verdict%% *}" = "PASS" ]; then record J04_docker_inspect PASS "privileged=false, ro rootfs, cap-drop ALL, no-new-privileges, $USER_SPEC, minne $MEMORY (ingen swap), pids $PIDS, cpus $CPUS, nett $NETWORK, kun /work montert, ingen docker.sock, ingen forbudte env"; else record J04_docker_inspect FAIL "${verdict#FAIL }"; fi
  KEEP_JOB="$JOB_ID"
}

check_J05() {
  local fails=() t=15000
  JOB_ID="${KEEP_JOB:-}"
  if [ -z "$JOB_ID" ]; then record J05_inne_i_containeren SKIP "ingen jobb fra J04"; return; fi
  cexec $t id -u; { [ "$EXEC_CODE" = "0" ] && [ "${EXEC_OUT//[$'\n']/}" = "$CONTAINER_UID" ]; } || fails+=("uid=${EXEC_OUT//[$'\n']/} (forventet $CONTAINER_UID)")
  cexec $t sh -c 'grep CapEff /proc/self/status'; case "$EXEC_OUT" in *"0000000000000000"*) : ;; *) fails+=("CapEff ikke null: ${EXEC_OUT//[$'\n']/}") ;; esac
  cexec $t sh -c 'test -e /var/run/docker.sock || test -e /run/docker.sock'; [ "$EXEC_CODE" != "0" ] || fails+=("docker.sock finnes i containeren")
  cexec $t sh -c 'touch /usr/aksept-test 2>&1'; [ "$EXEC_CODE" != "0" ] || fails+=("rootfs er skrivbar")
  cexec $t sh -c 'touch /work/aksept && rm /work/aksept'; [ "$EXEC_CODE" = "0" ] || fails+=("/work ikke skrivbar")
  cexec $t sh -c 'touch /home/job/aksept && touch /tmp/aksept'; [ "$EXEC_CODE" = "0" ] || fails+=("tmpfs /home/job eller /tmp ikke skrivbar")
  cexec $t sh -c 'cp /bin/true /tmp/aksept-true && /tmp/aksept-true'; [ "$EXEC_CODE" != "0" ] || fails+=("/tmp er ikke noexec")
  # kun MONTERINGSMÅL (felt 2) vurderes - kildeenheten kan hete «/dev/root» uten at noe av verten er montert
  cexec $t sh -c "awk '{print \$2}' /proc/mounts"
  if printf '%s\n' "$EXEC_OUT" | grep -Eq '(docker\.sock|^/(host|mnt/host|root|var/run|run/docker)($|/)|^/etc/jarvis|^/var/lib/jarvis|^/home/[^j]|^/volume)'; then fails+=("uventet monteringsmål i /proc/mounts: $(printf '%s' "$EXEC_OUT" | grep -E 'docker\.sock|^/(host|mnt/host|root|var/run|run/docker)($|/)|^/etc/jarvis|^/var/lib/jarvis|^/home/[^j]|^/volume' | head -3 | tr '\n' ' ')"); fi
  cexec $t sh -c 'test -e /root/.ssh -o -e /home/job/.ssh -o -e /host -o -e /mnt/host'; [ "$EXEC_CODE" != "0" ] || fails+=("vertsmapper synlige (/root/.ssh, /host)")
  cexec $t sh -c 'env | cut -d= -f1 | sort'
  if printf '%s\n' "$EXEC_OUT" | grep -Eq '^(GITHUB_TOKEN|GH_TOKEN|JARVIS_GIT_CREDENTIAL_TOKEN|JARVIS_GITHUB_TOKEN|GIT_ASKPASS|SSH_AUTH_SOCK|INFISICAL_.*|POSTGRES_.*|PGPASSWORD|JARVIS_DB_.*)$'; then fails+=("forbudt env-navn i containeren"); fi
  cexec $t sh -c 'git config --list --show-origin 2>/dev/null | grep -Ei "credential|extraheader|url\." ; true'
  [ -z "${EXEC_OUT//[$'\n']/}" ] || fails+=("git-config i containeren har credential/url-omskriving")
  cexec $t sh -c 'cd /work && git remote -v'
  [ -z "${EXEC_OUT//[$'\n']/}" ] || fails+=("arbeidskopien har en remote")
  delete_job "$JOB_ID"; KEEP_JOB=""
  if [ "${#fails[@]}" -eq 0 ]; then record J05_inne_i_containeren PASS "uid $CONTAINER_UID, CapEff=0, ingen docker.sock, ro rootfs, noexec tmpfs, ingen vertsmapper/hemmelighets-env, ingen git-remote/credential"; else record J05_inne_i_containeren FAIL "${fails[*]}"; fi
}

check_J06() {
  create_job || { record J06_ressursgrenser FAIL "kunne ikke opprette jobb"; return; }
  local fails=() name="$CONTAINER"
  # minne: allokér til OOM (grensen er $MEMORY, ingen swap)
  cexec 120000 node -e 'const a=[];for(;;)a.push(Buffer.alloc(64*1024*1024,1))'
  { [ "$EXEC_CODE" != "0" ] && [ "$EXEC_CODE" != "http000" ]; } || fails+=("minnegrensen stoppet ikke allokeringen (kode $EXEC_CODE)")
  # pids: spawn til EAGAIN
  cexec 60000 node -e 'const {spawn}=require("child_process");let ok=0;for(let i=0;i<2000;i++){const c=spawn("sleep",["30"],{stdio:"ignore"});c.on("error",()=>{});c.unref();if(c.pid)ok++}console.log(ok);process.exit(0)'
  local spawned="${EXEC_OUT//[$'\n']/}"
  if [[ "$spawned" =~ ^[0-9]+$ ]] && [ "$spawned" -lt $((PIDS + 64)) ]; then : ; else fails+=("pids-grensen holdt ikke (spawnet=$spawned, grense=$PIDS)"); fi
  # tidsavbrudd dreper containeren
  cexec 2000 sleep 60
  { [ "$EXEC_CODE" = "124" ] && wait_gone "$name" 10; } || fails+=("tidsavbrudd drepte ikke containeren (kode=$EXEC_CODE)")
  delete_job "$JOB_ID"
  if [ "${#fails[@]}" -eq 0 ]; then record J06_ressursgrenser PASS "OOM ved $MEMORY, pids-grense $PIDS holdt (spawnet $spawned), tidsavbrudd (124) fjernet containeren"; else record J06_ressursgrenser FAIL "${fails[*]}"; fi
}

# Node-snutt som kobler til $1:$2 og skriver CONNECTED/BLOCKED (kort tidsavbrudd; avvist/reset/unreachable = BLOCKED)
NODE_PROBE='const net=require("net");const [h,p]=[process.argv[1],Number(process.argv[2])];const s=net.connect({host:h,port:p,timeout:3000});s.on("connect",()=>{console.log("CONNECTED");s.destroy()});s.on("timeout",()=>{console.log("BLOCKED");s.destroy()});s.on("error",()=>{console.log("BLOCKED")});s.on("close",()=>process.exit(0))'
# Node-snutt: CONNECT $1 via proxyen $2:$3; skriver HTTP-statuskoden (eller ERR)
NODE_CONNECT='const http=require("http");const [target,ph,pp]=[process.argv[1],process.argv[2],Number(process.argv[3])];const r=http.request({host:ph,port:pp,method:"CONNECT",path:target,timeout:8000});r.on("connect",(res,sock)=>{console.log(res.statusCode);sock.destroy()});r.on("response",(res)=>{console.log(res.statusCode);res.resume()});r.on("timeout",()=>{console.log("TIMEOUT");r.destroy()});r.on("error",()=>console.log("ERR"));r.end()'
NODE_GET='const http=require("http");const [ph,pp]=[process.argv[1],Number(process.argv[2])];const r=http.request({host:ph,port:pp,method:"GET",path:"http://github.com/",headers:{Host:"github.com"},timeout:8000},(res)=>{console.log(res.statusCode);res.resume()});r.on("timeout",()=>{console.log("TIMEOUT");r.destroy()});r.on("error",()=>console.log("ERR"));r.end()'

check_J07() {
  [ -n "$GATEWAY" ] || { record J07_nettverk_deny_by_default SKIP "egress_proxy.listen_host mangler i config"; return; }
  create_job || { record J07_nettverk_deny_by_default FAIL "kunne ikke opprette jobb"; return; }
  local fails=() a_id="$JOB_ID" a_name="$CONTAINER" out
  # a) direkte rute ut: skal være umulig
  cexec 30000 node -e "$NODE_PROBE" 1.1.1.1 443; [ "${EXEC_OUT//[$'\n']/}" = "BLOCKED" ] || fails+=("direkte TCP til 1.1.1.1:443 lyktes")
  cexec 30000 node -e "$NODE_PROBE" 8.8.8.8 53; [ "${EXEC_OUT//[$'\n']/}" = "BLOCKED" ] || fails+=("direkte TCP til 8.8.8.8:53 lyktes")
  # b) tjenester på VERTEN via bridge-adressen (kun proxyens port skal være åpen)
  local port
  for port in 22 53 80 111 139 443 445 2049 3306 5000 5001 5432 8080 9999; do
    [ "$port" = "$PROXY_PORT" ] && continue
    cexec 30000 node -e "$NODE_PROBE" "$GATEWAY" "$port"; [ "${EXEC_OUT//[$'\n']/}" = "BLOCKED" ] || fails+=("verts-port $GATEWAY:$port nåbar fra jobb-container")
  done
  cexec 30000 node -e "$NODE_PROBE" "$GATEWAY" "$PROXY_PORT"; [ "${EXEC_OUT//[$'\n']/}" = "CONNECTED" ] || fails+=("proxyen $GATEWAY:$PROXY_PORT er IKKE nåbar (kontroll)")
  # c) proxy-oppførsel sett fra containeren
  cexec 30000 node -e "$NODE_CONNECT" github.com:443 "$GATEWAY" "$PROXY_PORT"; [ "${EXEC_OUT//[$'\n']/}" = "200" ] || fails+=("CONNECT github.com:443 ga ${EXEC_OUT//[$'\n']/}, forventet 200")
  for target in example.com:443 169.254.169.254:80 10.0.0.1:443 localhost:5432 github.com:22 127.0.0.1:443; do
    cexec 30000 node -e "$NODE_CONNECT" "$target" "$GATEWAY" "$PROXY_PORT"
    case "${EXEC_OUT//[$'\n']/}" in 400|403) : ;; *) fails+=("CONNECT $target ga ${EXEC_OUT//[$'\n']/}, forventet 400/403") ;; esac
  done
  cexec 30000 node -e "$NODE_GET" "$GATEWAY" "$PROXY_PORT"; [ "${EXEC_OUT//[$'\n']/}" = "405" ] || fails+=("vanlig HTTP GET via proxy ga ${EXEC_OUT//[$'\n']/}, forventet 405")
  # c2) IPv6 (kun OBSERVASJON, feiler aldri sjekken): jobbnettverket er IPv4-only. En ikke-loopback IPv6-adresse i containeren ville åpnet en vei de IPv4-reglene
  #     over ikke dekker (se runbooken, «IPv6»). Tallet skal være 0; er det ikke det, må eieren legge til tilsvarende ip6tables-regler.
  cexec 20000 sh -c 'grep -vc "^00000000000000000000000000000001 " /proc/net/if_inet6 2>/dev/null; true'
  local v6="${EXEC_OUT//[$'\n']/}"; v6="${v6:-?}"
  # d) jobb-containere når ikke hverandre (enable_icc=false)
  local a_ip; a_ip="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$a_name" 2>/dev/null)"
  cexec 20000 sh -c "setsid nohup node -e 'require(\"net\").createServer(()=>{}).listen(9099,\"0.0.0.0\")' >/dev/null 2>&1 < /dev/null & sleep 1; echo started"
  create_job || { fails+=("kunne ikke opprette jobb nr. 2 for ICC-test"); }
  if [ -n "$JOB_ID" ] && [ "$JOB_ID" != "$a_id" ] && [ -n "$a_ip" ]; then
    cexec 30000 node -e "$NODE_PROBE" "$a_ip" 9099; [ "${EXEC_OUT//[$'\n']/}" = "BLOCKED" ] || fails+=("jobb-container B nådde jobb-container A ($a_ip:9099): enable_icc er ikke false")
    delete_job "$JOB_ID"
  else
    fails+=("ICC-test kunne ikke kjøres (ip=$a_ip)")
  fi
  delete_job "$a_id"
  if [ "${#fails[@]}" -eq 0 ]; then record J07_nettverk_deny_by_default PASS "ingen direkte rute ut; ingen vertsporter nåbare unntatt proxyen $GATEWAY:$PROXY_PORT; github OK, fremmed/privat/metadata nektet, GET=405; jobb-containere når ikke hverandre; ikke-loopback IPv6-adresser i containeren: $v6 (forventet 0)"; else record J07_nettverk_deny_by_default FAIL "${fails[*]}"; fi
}

check_J08() {
  create_job || { record J08_kansellering FAIL "kunne ikke opprette jobb"; return; }
  local id="$JOB_ID" name="$CONTAINER"
  local body; body="$(node -e 'process.stdout.write(JSON.stringify({argv:["sleep","600"],timeout_ms:900000}))')"
  ( curl -sS --max-time 120 --unix-socket "$SOCKET" -X POST -H "@$WORK/auth.hdr" -H 'Content-Type: application/json' --data-binary "$body" -o "$WORK/cancel-exec.json" -w '%{http_code}' "http://localhost/v1/jobs/$id/exec" > "$WORK/cancel-exec.code" 2>/dev/null ) &
  local bg=$!
  sleep 3
  local t0=$SECONDS
  delete_job "$id"
  local del="$HTTP_CODE"
  if wait_gone "$name" 5; then
    local took=$((SECONDS - t0))
    wait "$bg" 2>/dev/null || true
    local after; after="$(cat "$WORK/cancel-exec.code" 2>/dev/null)"
    record J08_kansellering PASS "DELETE (http $del) fjernet containeren på ${took}s mens 'sleep 600' kjørte; ventende exec avsluttet (http ${after:-?})"
  else
    kill "$bg" 2>/dev/null || true
    record J08_kansellering FAIL "containeren levde etter DELETE (http $del)"
  fi
}

check_J09() {
  if [ "$WITH_RESTART" != "1" ]; then record J09_reclaim_etter_krasj SKIP "kjør med --with-restart (krever root)"; return; fi
  [ "$(id -u)" = "0" ] || { record J09_reclaim_etter_krasj SKIP "--with-restart krever root"; return; }
  create_job || { record J09_reclaim_etter_krasj FAIL "kunne ikke opprette jobb"; return; }
  local name="$CONTAINER" id="$JOB_ID"
  systemctl kill --signal=SIGKILL jarvis-job-runner.service
  sleep 2
  local alive_after_crash=no; container_exists "$name" && alive_after_crash=ja
  systemctl restart jarvis-job-runner.service
  local i up=0
  for i in $(seq 1 30); do api GET /v1/health; [ "$HTTP_CODE" = "200" ] && { up=1; break; }; sleep 1; done
  CREATED_JOBS=()
  if [ "$up" = "1" ] && wait_gone "$name" 10; then
    local dir_gone=ukjent; [ -d "$BASE_DIR" ] && { [ -e "$BASE_DIR/$id" ] && dir_gone=nei || dir_gone=ja; }
    if [ "$dir_gone" = "nei" ]; then record J09_reclaim_etter_krasj FAIL "containeren er borte, men jobbkatalogen $id ligger igjen"; else record J09_reclaim_etter_krasj PASS "container overlevde krasjet=$alive_after_crash; etter restart er containeren fjernet og katalogen (ryddet=$dir_gone)"; fi
  else
    record J09_reclaim_etter_krasj FAIL "runner oppe=$up, container fjernet=$(container_exists "$name" && echo nei || echo ja)"
  fi
}

check_J10() {
  if [ "$WITH_TTL" != "1" ]; then record J10_ttl SKIP "kjør med --with-ttl (venter ca. ${LIFETIME}s + rydde-intervall; sett gjerne runner.max_job_lifetime_s=60 midlertidig)"; return; fi
  create_job || { record J10_ttl FAIL "kunne ikke opprette jobb"; return; }
  local name="$CONTAINER" i
  for ((i=0; i<LIFETIME+60; i+=5)); do container_exists "$name" || break; sleep 5; done
  if container_exists "$name"; then record J10_ttl FAIL "containeren levde etter ${LIFETIME}s + 60s"; else record J10_ttl PASS "jobben ble fjernet av TTL-rydderen etter ca. ${i}s (grense ${LIFETIME}s)"; fi
  CREATED_JOBS=()
}

check_J11() {
  if [ -z "$REPO" ]; then record J11_ende_til_ende_publish SKIP "ACCEPTANCE_REPO mangler"; return; fi
  local fails=() branch="${PREFIX}accept-$STAMP"
  create_job || { record J11_ende_til_ende_publish FAIL "kunne ikke opprette jobb (http=$HTTP_CODE $(resp_get error))"; return; }
  cexec 60000 sh -c "echo 'akseptanse $STAMP' > AKSEPTANSE.txt && git checkout -q -b '$branch' && git add -A && git commit -q -m 'jarvis: job-runner akseptanse $STAMP' && git rev-parse HEAD"
  local sha="${EXEC_OUT//[$'\n']/}"
  [ "$EXEC_CODE" = "0" ] || fails+=("commit i containeren feilet: $EXEC_ERR")
  api POST "/v1/jobs/$JOB_ID/publish" "$(node -e 'process.stdout.write(JSON.stringify({branch:process.argv[1]}))' "$branch")"
  if [ "$HTTP_CODE" = "200" ] && [ "$(resp_get commit_sha)" = "$sha" ] && [ -n "$sha" ]; then :; else fails+=("publish: http=$HTTP_CODE $(resp_get error) $(resp_get detail)"); fi
  # negative: main, beskyttede navn, ingen prefiks
  local b
  for b in main master production "refs/heads/main" "${PREFIX}../main"; do
    api POST "/v1/jobs/$JOB_ID/publish" "$(node -e 'process.stdout.write(JSON.stringify({branch:process.argv[1]}))' "$b")"
    [ "$HTTP_CODE" = "400" ] || fails+=("publish til '$b' ble ikke avvist (http $HTTP_CODE)")
  done
  delete_job "$JOB_ID"
  # nektet sti
  if create_job; then
    cexec 60000 sh -c "mkdir -p .github/workflows && echo 'name: x' > .github/workflows/x.yml && git checkout -q -b '${PREFIX}accept-denied-$STAMP' && git add -A && git commit -q -m x"
    api POST "/v1/jobs/$JOB_ID/publish" "$(node -e 'process.stdout.write(JSON.stringify({branch:process.argv[1]}))' "${PREFIX}accept-denied-$STAMP")"
    { [ "$HTTP_CODE" = "422" ] && [ "$(resp_get error)" = "path_denied" ]; } || fails+=(".github/workflows ble ikke nektet (http $HTTP_CODE $(resp_get error))")
    delete_job "$JOB_ID"
  else
    fails+=("kunne ikke opprette jobb for nektet-sti-testen (http $HTTP_CODE)")
  fi
  # ingen endringer
  if create_job; then
    api POST "/v1/jobs/$JOB_ID/publish" "$(node -e 'process.stdout.write(JSON.stringify({branch:process.argv[1]}))' "${PREFIX}accept-empty-$STAMP")"
    { [ "$HTTP_CODE" = "422" ] && [ "$(resp_get error)" = "no_changes" ]; } || fails+=("publish uten endringer ble ikke avvist (http $HTTP_CODE $(resp_get error))")
    delete_job "$JOB_ID"
  else
    fails+=("kunne ikke opprette jobb for ingen-endringer-testen (http $HTTP_CODE)")
  fi
  # verifiser at branchen finnes (valgfritt: GH_TOKEN med LES-tilgang)
  if [ -n "${GH_TOKEN:-}" ]; then
    printf 'Authorization: Bearer %s\n' "$GH_TOKEN" > "$WORK/gh.hdr"; chmod 600 "$WORK/gh.hdr"
    local remote_sha; remote_sha="$(curl -sS -H "@$WORK/gh.hdr" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/git/ref/heads/$branch" | jget object.sha)"
    [ "$remote_sha" = "$sha" ] || fails+=("GitHub har ikke branchen $branch på $sha (fant '$remote_sha')")
    local main_check; main_check="$(curl -sS -H "@$WORK/gh.hdr" -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$REPO/git/ref/heads/${PREFIX}accept-denied-$STAMP")"
    [ "$main_check" = "404" ] || fails+=("den nektede branchen ble likevel pushet (http $main_check)")
  fi
  PUBLISHED_BRANCH="$branch"; PUBLISHED_SHA="$sha"
  if [ "${#fails[@]}" -eq 0 ]; then record J11_ende_til_ende_publish PASS "branch $branch @ ${sha:0:12} publisert via verifisert bundle; main/beskyttede navn/.github/ingen endringer avvist${GH_TOKEN:+; bekreftet via GitHub API}${GH_TOKEN:-; bekreft manuelt: git ls-remote https://github.com/$REPO $branch}"; else record J11_ende_til_ende_publish FAIL "${fails[*]}"; fi
}

check_J12() {
  : > "$WORK/secrets"; chmod 600 "$WORK/secrets"
  tr -d '\n' < "$TOKEN_FILE" >> "$WORK/secrets" 2>/dev/null || true; printf '\n' >> "$WORK/secrets"
  local pat
  IFS=',' read -ra pats <<<"$PAT_FILES"
  for pat in "${pats[@]}"; do [ -r "$pat" ] && { tr -d '\n' < "$pat" >> "$WORK/secrets"; printf '\n' >> "$WORK/secrets"; }; done
  [ -n "${ANTHROPIC_API_KEY:-}" ] && printf '%s\n' "$ANTHROPIC_API_KEY" >> "$WORK/secrets"
  grep -v '^$' "$WORK/secrets" > "$WORK/secrets.f" || true
  if ! command -v journalctl >/dev/null 2>&1; then record J12_logger_uten_hemmeligheter SKIP "journalctl mangler"; return; fi
  local hits
  hits="$(journalctl -u jarvis-job-runner -u jarvis-egress-proxy --since "3 hours ago" --no-pager -o cat 2>/dev/null | grep -Fc -f "$WORK/secrets.f" || true)"
  local extra=""
  if command -v gitleaks >/dev/null 2>&1 && [ -n "${PUBLISHED_BRANCH:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
    local tmp="$WORK/gl"; mkdir -p "$tmp"
    printf '[http "https://github.com/"]\n\textraHeader = Authorization: Bearer %s\n' "$GH_TOKEN" > "$WORK/gitcfg"; chmod 600 "$WORK/gitcfg"
    if GIT_CONFIG_GLOBAL="$WORK/gitcfg" git clone -q --depth 5 --branch "$PUBLISHED_BRANCH" "https://github.com/$REPO.git" "$tmp/repo" 2>/dev/null; then
      if gitleaks detect --source "$tmp/repo" --no-banner --redact >/dev/null 2>&1; then extra="; gitleaks: ingen funn på $PUBLISHED_BRANCH"; else extra="; gitleaks: FUNN på $PUBLISHED_BRANCH"; hits=$((hits + 1)); fi
    fi
  fi
  if [ "${hits:-0}" = "0" ]; then record J12_logger_uten_hemmeligheter PASS "journal (siste 3 t) for begge tjenester har 0 treff på token/PAT$extra"; else record J12_logger_uten_hemmeligheter FAIL "$hits treff på hemmelighet i journal/gitleaks$extra"; fi
}

check_J13() {
  if [ "${ACCEPT_LIVE_CLAUDE:-0}" != "1" ]; then record J13_live_claude SKIP "sett ACCEPT_LIVE_CLAUDE=1 og ANTHROPIC_API_KEY (liten, ekte kjøring; koster noen øre)"; return; fi
  [ -n "${ANTHROPIC_API_KEY:-}" ] || { record J13_live_claude SKIP "ANTHROPIC_API_KEY mangler i miljøet"; return; }
  create_job "$(node -e 'process.stdout.write(JSON.stringify({ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY}))')" || { record J13_live_claude FAIL "kunne ikke opprette jobb"; return; }
  cexec 20000 claude --version
  local ver="${EXEC_OUT//[$'\n']/}"
  cexec 240000 claude --bare -p "Svar med nøyaktig ett ord: OK" --output-format json --permission-mode acceptEdits --allowedTools "Read,Edit"
  local code="$EXEC_CODE" ok=no
  case "$EXEC_OUT" in *'"result"'*OK*|*'"result": "OK'*) ok=ja ;; esac
  delete_job "$JOB_ID"
  if [ "$code" = "0" ] && [ "$ok" = "ja" ]; then record J13_live_claude PASS "claude $ver svarte via proxyen (container -> proxy -> api.anthropic.com)"; else record J13_live_claude FAIL "claude $ver kode=$code ok=$ok: ${EXEC_ERR:0:160}"; fi
}

check_M01() {
  record M01_github_beskyttelse MANUELL "Bekreft i GitHub for $REPO og produksjonsrepoet: (16) branch protection på main (krev PR, blokker force-push og sletting, også for admin); (17) PR krever menneskelig merge; (18) PAT-en er fine-grained, begrenset til ETT repo, kun Contents: write + Pull requests: write (ingen Administration/Workflows); slett testbranchen ${PUBLISHED_BRANCH:-jarvis/accept-*} etterpå"
}

# ============================= hoved =======================================================================================================
main() {
  if [ "$DRY" = "1" ]; then
    echo "TØRRKJØRING - sjekklisten (ingen docker, ingen nettverk):"
    printf '  %s\n' "${CHECKLIST[@]}"
    echo "Ikke i denne kjøringen: kall mot runneren, docker, systemctl. Kjør uten --dry-run på NAS-en."
    return 0
  fi
  for tool in docker curl node; do command -v "$tool" >/dev/null 2>&1 || { echo "mangler $tool - kjør dette på NAS-en" >&2; return 2; }; done
  [ -n "$REPO" ] || { echo "ACCEPTANCE_REPO er påkrevd (et SANDBOX-repo i runner.allowed_repos - aldri produksjonsrepoet)" >&2; return 2; }
  [ -r "$CONFIG" ] || { echo "kan ikke lese $CONFIG" >&2; return 2; }
  load_policy || { echo "kunne ikke lese policy fra $CONFIG" >&2; return 2; }
  case ",$ALLOWED," in *",$REPO,"*) : ;; *) echo "ACCEPTANCE_REPO=$REPO står ikke i runner.allowed_repos ($ALLOWED) - avbryter" >&2; return 2 ;; esac
  [ -r "$TOKEN_FILE" ] || { echo "kan ikke lese tokenfilen (er du medlem av gruppen jarvis-job-clients, eller root?)" >&2; return 2; }
  [ -S "$SOCKET" ] || { echo "finner ikke socketen $SOCKET (kjører jarvis-job-runner?)" >&2; return 2; }

  WORK="$(mktemp -d)"; chmod 700 "$WORK"
  trap cleanup EXIT
  ( umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$TOKEN_FILE")" > "$WORK/auth.hdr" )
  KEEP_JOB=""; PUBLISHED_BRANCH=""; PUBLISHED_SHA=""

  echo "== job-runner-akseptanse $STAMP  repo=$REPO  nettverk=$NETWORK  image=${IMAGE:0:19}…"
  check_J01; check_J02; check_J03; check_J04; check_J05; check_J06; check_J07; check_J08; check_J09; check_J10; check_J11; check_J12; check_J13; check_M01

  mkdir -p "$OUT_DIR"
  {
    echo "# Job-runner-akseptanse $STAMP"
    echo
    echo "Repo (sandbox): \`$REPO\` · nettverk \`$NETWORK\` · bruker \`$USER_SPEC\` · image \`${IMAGE:0:19}…\`"
    echo
    echo "| Sjekk | Status | Detalj |"
    echo "|---|---|---|"
    printf '%s\n' "${ROWS[@]}"
    echo
    echo "**SAMMENDRAG: $PASS PASS, $FAIL FAIL, $SKIP SKIP, $MANUAL MANUELL.** PASS gjelder kun denne målingen på denne verten. Ingen hemmeligheter er skrevet til denne filen."
  } > "$OUT_FILE"
  echo
  echo "SAMMENDRAG: $PASS PASS, $FAIL FAIL, $SKIP SKIP, $MANUAL MANUELL  (evidens: $OUT_FILE)"
  [ "$FAIL" = "0" ]
}

if [ "${ACCEPTANCE_SOURCE_ONLY:-0}" != "1" ]; then
  main
  exit $?
fi
