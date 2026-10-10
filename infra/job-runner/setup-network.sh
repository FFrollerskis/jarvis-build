#!/usr/bin/env bash
# WP-C1 (D-32 port 9): oppretter (idempotent) det INTERNE jobbnettverket og verts-brannmurreglene som gjør nettverket deny-by-default.
#
#   sudo infra/job-runner/setup-network.sh            # opprett/verifiser (kalles også av jarvis-egress-proxy.service som ExecStartPre)
#   sudo infra/job-runner/setup-network.sh --check    # KUN verifiser; endrer ingenting; exit 1 hvis noe mangler/avviker
#
# Alt leses fra policy-konfigen (JARVIS_JOB_RUNNER_CONFIG, standard /etc/jarvis/job-runner.json) - én kilde til sannhet:
#   runner.network                       -> nettverksnavn
#   egress_proxy.listen_host             -> nettverkets GATEWAY-adresse (proxyen lytter her, og kun her)
#   egress_proxy.listen_port             -> proxyens port
#   egress_proxy.allowed_client_cidrs[0] -> nettverkets SUBNETT
#
# Hvorfor brannmurreglene: et `--internal` Docker-nettverk har ingen rute ut, men containerne kan fortsatt nå tjenester på VERTEN via
# bridge-adressen (Docker-dokumentasjon, «Gateway modes»: «containers in the network can access host services listening on that bridge
# address (including services listening on "any" host address)»). Uten reglene under ville en jobb-container kunne nå SSH, NAS-grensesnitt,
# SMB m.m. på verten. Reglene slipper KUN TCP til proxyens adresse:port inn og avviser resten fra jobbnettverkets bridge.
set -euo pipefail

CHECK_ONLY=0
case "${1:-}" in
  "") ;;
  --check) CHECK_ONLY=1 ;;
  *) echo "ukjent argument: $1 (bruk --check eller ingen argument)" >&2; exit 2 ;;
esac

CONFIG="${JARVIS_JOB_RUNNER_CONFIG:-/etc/jarvis/job-runner.json}"
CHAIN="JARVIS-JOBS-IN"
BRIDGE_NAME="br-jarvis-jobs"
FAILED=0
fail() { echo "FEIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }

[ "$(id -u)" = "0" ] || { echo "må kjøres som root (docker + iptables)" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke" >&2; exit 2; }
command -v iptables >/dev/null 2>&1 || { echo "iptables finnes ikke: uten INPUT-reglene kan jobb-containere nå tjenester på verten. Se docs/runbooks/JOB_RUNNER.md («Brannmur») for nft-ekvivalent." >&2; exit 2; }
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node finnes ikke" >&2; exit 2; }
[ -r "$CONFIG" ] || { echo "kan ikke lese $CONFIG" >&2; exit 2; }

# --- les policy (validert på nytt her; verdiene er vertsadmins, men en skrivefeil skal aldri bli en shell-streng) ---
PARSED="$("$NODE_BIN" -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const r = c.runner, p = c.egress_proxy;
  if (!r || !p) { console.error("config mangler runner- eller egress_proxy-seksjon"); process.exit(1); }
  const cidr = (p.allowed_client_cidrs || [])[0];
  if (!r.network || !p.listen_host || !cidr) { console.error("config mangler runner.network, egress_proxy.listen_host eller allowed_client_cidrs"); process.exit(1); }
  console.log([r.network, p.listen_host, p.listen_port || 3128, cidr].join(" "));
' "$CONFIG")" || { echo "kunne ikke lese policy fra $CONFIG" >&2; exit 2; }
read -r NETWORK GATEWAY PORT SUBNET <<<"$PARSED"
[[ "$NETWORK" =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || { echo "ugyldig nettverksnavn: $NETWORK" >&2; exit 2; }
case "$NETWORK" in host|bridge|none|default) echo "nettverket må være et dedikert jobbnettverk, ikke $NETWORK" >&2; exit 2 ;; esac
[[ "$GATEWAY" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "ugyldig gateway/listen_host: $GATEWAY" >&2; exit 2; }
[ "$GATEWAY" != "0.0.0.0" ] || { echo "listen_host kan ikke være 0.0.0.0" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo "ugyldig port: $PORT" >&2; exit 2; }
[[ "$SUBNET" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo "ugyldig subnett: $SUBNET" >&2; exit 2; }

# --- 1. nettverket: internt, bridge, riktig subnett/gateway, ingen kommunikasjon mellom jobb-containere ---
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  INFO="$(docker network inspect --format '{{.Internal}}|{{.Driver}}|{{range .IPAM.Config}}{{.Subnet}},{{.Gateway}};{{end}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{index .Options "com.docker.network.bridge.name"}}' "$NETWORK")"
  IFS='|' read -r INTERNAL DRIVER IPAM ICC BRIDGE_ACTUAL <<<"$INFO"
  [ "$INTERNAL" = "true" ] && ok "$NETWORK er --internal" || fail "$NETWORK er IKKE --internal (jobber ville hatt direkte rute ut). Fjern og opprett på nytt: docker network rm $NETWORK && $0"
  [ "$DRIVER" = "bridge" ] && ok "driver bridge" || fail "driver er $DRIVER, forventet bridge"
  case "$IPAM" in *"$SUBNET,$GATEWAY;"*) ok "subnett $SUBNET / gateway $GATEWAY" ;; *) fail "subnett/gateway avviker fra policy (fant: $IPAM)" ;; esac
  [ "$ICC" = "false" ] && ok "enable_icc=false (jobb-containere når ikke hverandre)" || fail "enable_icc er ikke false (jobb-containere kan nå hverandre)"
  BRIDGE="${BRIDGE_ACTUAL:-}"
  if [ -z "$BRIDGE" ]; then BRIDGE="br-$(docker network inspect --format '{{.Id}}' "$NETWORK" | cut -c1-12)"; fi
elif [ "$CHECK_ONLY" = "1" ]; then
  fail "nettverket $NETWORK finnes ikke"
  BRIDGE="$BRIDGE_NAME"
else
  docker network create --driver bridge --internal --subnet "$SUBNET" --gateway "$GATEWAY" \
    --opt "com.docker.network.bridge.name=$BRIDGE_NAME" --opt "com.docker.network.bridge.enable_icc=false" "$NETWORK" >/dev/null
  ok "opprettet $NETWORK (--internal, $SUBNET, gateway $GATEWAY, bridge $BRIDGE_NAME, icc=false)"
  BRIDGE="$BRIDGE_NAME"
fi

# --- 2. INPUT-regler: fra jobbnettverkets bridge slippes KUN TCP til proxyen inn; alt annet mot verten avvises ---
RULES="*filter
:$CHAIN - [0:0]
-A $CHAIN -p tcp -d $GATEWAY --dport $PORT -j ACCEPT
-A $CHAIN -p tcp -j REJECT --reject-with tcp-reset
-A $CHAIN -j REJECT --reject-with icmp-port-unreachable
COMMIT
"
JUMP="-A INPUT -i $BRIDGE -j $CHAIN"
input_rules() { iptables -w -S INPUT 2>/dev/null || true; }   # linje 1 = «-P INPUT <policy>», regel nr. N = linje N+1
jump_count() { input_rules | grep -c -x -- "$JUMP" || true; }
if [ "$CHECK_ONLY" = "0" ]; then
  # --noflush: rører bare denne kjeden (deklarasjonen nullstiller den atomisk); øvrige regler (Docker, ufw, firewalld) er urørt.
  printf '%s' "$RULES" | iptables-restore --noflush
  # Hoppet skal ligge ØVERST i INPUT. Settes inn FØRST (aldri et vindu uten dekning); eldre duplikater lenger ned fjernes etterpå, sist først.
  if [ "$(input_rules | sed -n '2p')" != "$JUMP" ]; then iptables -w -I INPUT 1 -i "$BRIDGE" -j "$CHAIN"; fi
  while [ "$(jump_count)" -gt 1 ]; do
    LAST_LINE="$(input_rules | grep -n -x -- "$JUMP" | tail -1 | cut -d: -f1)"
    iptables -w -D INPUT "$((LAST_LINE - 1))"
  done
fi
JUMPS="$(jump_count)"
if [ "$JUMPS" = "1" ]; then ok "INPUT -i $BRIDGE -> $CHAIN (nøyaktig ett hopp)"; else fail "INPUT-hoppet fra $BRIDGE til $CHAIN finnes $JUMPS ganger (forventet 1)"; fi
LISTED="$(iptables -w -S "$CHAIN" 2>/dev/null || true)"
GATEWAY_RE="${GATEWAY//./\\.}"
if printf '%s\n' "$LISTED" | grep -Eq -- "^-A $CHAIN .*-d $GATEWAY_RE(/32)? .*--dport $PORT .*-j ACCEPT$"; then ok "tillater kun tcp $GATEWAY:$PORT"; else fail "regelen som tillater $GATEWAY:$PORT finnes ikke i $CHAIN"; fi
case "$LISTED" in *"-j REJECT"*) ok "resten avvises" ;; *) fail "avvis-regel mangler i $CHAIN" ;; esac
# Rekkefølge: hoppet må ligge FØR enhver ACCEPT-regel i INPUT som kunne truffet trafikk fra jobbnettverket (uten -i, med -i <wildcard+>, eller med «! -i»).
# En ACCEPT bundet til ett bestemt annet grensesnitt (f.eks. «-i lo») kan ikke treffe jobbtrafikk og er ufarlig.
JUMP_LINE="$(input_rules | grep -n -x -- "$JUMP" | head -1 | cut -d: -f1 || true)"
GENERIC_ACCEPT_LINE="$(input_rules | awk '/ -j ACCEPT/ { generic = 1; if ($0 ~ / -i [^ +]+ / && $0 !~ / ! -i /) generic = 0; if (generic) { print NR; exit } }' || true)"
if [ -n "$JUMP_LINE" ] && { [ -z "$GENERIC_ACCEPT_LINE" ] || [ "$JUMP_LINE" -lt "$GENERIC_ACCEPT_LINE" ]; }; then ok "hoppet ligger foran generelle ACCEPT-regler"; else fail "hoppet ligger IKKE foran generelle ACCEPT-regler i INPUT (kjør uten --check for å legge det først)"; fi

# --- 3. IPv6 (B-L3): nettverket opprettes uten --ipv6, men verten kan ha IPv6 på bridgen (link-local). Alt fra jobbnettverkets bridge til VERTEN over IPv6 avvises (DROP) i en egen kjede, med samme
#        oppsett (hopp øverst i INPUT, idempotent, --check). Proxyen lytter kun på IPv4, så det finnes ingenting å slippe inn. Mangler ip6tables, advares det (ikke fatalt: IPv6 kan være av).
CHAIN6="JARVIS-JOBS-IN6"
JUMP6="-A INPUT -i $BRIDGE -j $CHAIN6"
if command -v ip6tables >/dev/null 2>&1 && command -v ip6tables-restore >/dev/null 2>&1; then
  input6_rules() { ip6tables -w -S INPUT 2>/dev/null || true; }
  jump6_count() { input6_rules | grep -c -x -- "$JUMP6" || true; }
  if [ "$CHECK_ONLY" = "0" ]; then
    printf '*filter\n:%s - [0:0]\n-A %s -j DROP\nCOMMIT\n' "$CHAIN6" "$CHAIN6" | ip6tables-restore --noflush || fail "ip6tables-restore feilet: IPv6-reglene for $BRIDGE er IKKE satt (fjern ip6tables, eller slå av IPv6, hvis det er bevisst)"
    if [ "$(input6_rules | sed -n '2p')" != "$JUMP6" ]; then ip6tables -w -I INPUT 1 -i "$BRIDGE" -j "$CHAIN6" || fail "ip6tables: kunne ikke sette inn hoppet til $CHAIN6"; fi
    while [ "$(jump6_count)" -gt 1 ]; do
      LAST_LINE6="$(input6_rules | grep -n -x -- "$JUMP6" | tail -1 | cut -d: -f1)"
      ip6tables -w -D INPUT "$((LAST_LINE6 - 1))" || break
    done
  fi
  JUMPS6="$(jump6_count)"
  if [ "$JUMPS6" = "1" ]; then ok "IPv6: INPUT -i $BRIDGE -> $CHAIN6 (nøyaktig ett hopp)"; else fail "IPv6: INPUT-hoppet fra $BRIDGE til $CHAIN6 finnes $JUMPS6 ganger (forventet 1)"; fi
  if ip6tables -w -S "$CHAIN6" 2>/dev/null | grep -Fxq -- "-A $CHAIN6 -j DROP"; then ok "IPv6: alt fra $BRIDGE mot verten avvises"; else fail "IPv6: DROP-regelen i $CHAIN6 mangler"; fi
  if [ "$(input6_rules | sed -n '2p')" = "$JUMP6" ]; then ok "IPv6: hoppet ligger øverst i INPUT"; else fail "IPv6: hoppet ligger IKKE øverst i INPUT (kjør uten --check for å legge det først)"; fi
else
  echo "ADVARSEL: ip6tables/ip6tables-restore finnes ikke: IPv6 fra $BRIDGE mot verten er IKKE filtrert. Nettverket har ikke --ipv6 (J07 observerer IPv6 i containeren, forventet 0), men har verten IPv6 bør ip6tables installeres." >&2
fi

if [ "$FAILED" = "0" ]; then echo "jobbnettverket er klart ($NETWORK, bridge $BRIDGE)"; exit 0; fi
exit 1
