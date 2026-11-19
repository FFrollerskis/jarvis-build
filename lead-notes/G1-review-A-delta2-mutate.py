#!/usr/bin/env python3
# Reviewer A delta: mutasjoner mot fiks-runden (d79b0434). Mutasjonen settes inn midlertidig og gjenopprettes ALLTID med `git checkout -- <fil>`.
import subprocess, sys, json, os, re
WT = "/home/user/jarvisbuild/.claude/worktrees/agent-aea9aa2c106dc3965"
OUT = "/tmp/claude-0/-home-user-jarvisbuild/f781b90f-9fc6-545a-b2ea-055acc984b23/scratchpad/rev-a3/mut"
os.makedirs(OUT, exist_ok=True)
C = "modules/comms/test/"
SL = C + "stop-slots.test.ts"
KS = C + "key-scope.test.ts"
RE = C + "relationship-evidence.test.ts"
CR = C + "caps-cross-room.test.ts"
OI = C + "outbound-integrity.test.ts"
S = "modules/comms/src/"
M = [
 ("N1-slots-shared", S + "store.ts", 'provider_error: "*provider", owner_recorded: "*owner", recipient_request: "*request"', 'provider_error: "*", owner_recorded: "*", recipient_request: "*"', [[SL]]),
 ("N1-existing-no-channel", S + "store.ts", "WHERE tenant_id = $1 AND recipient_hash = $2 AND channel = $3 AND account_ref = $4 AND status = 'active' LIMIT 1", "WHERE tenant_id = $1 AND recipient_hash = $2 AND $3::text IS NOT NULL AND account_ref = $4 AND status = 'active' LIMIT 1", [[SL]]),
 ("N1-start-any-source", S + "store.ts", "AND status = 'active' AND source IN ('inbound_stop_keyword', 'provider_error')", "AND status = 'active'", [[SL]]),
 ("N2-unscoped-key", S + "owner-actions.ts", "return `${action}:${tenantTag}:${key}`;", "return key;", [[KS]]),
 ("N2-key-max-200", S + "owner-actions.ts", "const KEY = /^[A-Za-z0-9._:-]{8,160}$/;", "const KEY = /^[A-Za-z0-9._:-]{8,200}$/;", [[KS]]),
 ("M2-methods-any", S + "policy.ts", '["exact_email", "exact_phone_e164", "exact_handle", "owner_configured"]', '["exact_email", "exact_phone_e164", "exact_handle", "owner_configured", "contact_sync", "manual"]', [[RE]]),
 ("M2-min-conf-0.5", S + "policy.ts", "export const RELATIONSHIP_MIN_CONFIDENCE = 0.9;", "export const RELATIONSHIP_MIN_CONFIDENCE = 0.5;", [[RE]]),
 ("M2-policy-any-identity", S + "policy.ts", 'state.recipient_identity !== null && isRelationshipEvidence(state.recipient_identity) ? "identity_link"', 'state.recipient_identity !== null ? "identity_link"', [[RE]]),
 ("M2-best-link-no-preference", S + "funnel.ts", "const pool = matching.some(isRelationshipEvidence) ? matching.filter(isRelationshipEvidence) : matching;", "const pool = matching;", [[RE]]),
 ("H2-begin-per-room", S + "store.ts", "COMMS_SPACES, async (client) => {\n      if (caps.recipient !== null)", "[space], async (client) => {\n      if (caps.recipient !== null)", [[CR]]),
 ("H2-dryrun-per-room", S + "store.ts", "return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.recipientCount(client, tenantId, channel, recipientHash, kind, this.clock()));", "return withMemoryTransaction(this.pool, tenantId, [_space], (client) => this.recipientCount(client, tenantId, channel, recipientHash, kind, this.clock()));", [[CR]]),
 ("H2-replay-per-room", S + "store.ts", "return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.priorAttemptOf(client, tenantId, requestId));", "return withMemoryTransaction(this.pool, tenantId, [_space], (client) => this.priorAttemptOf(client, tenantId, requestId));", [[CR]]),
 ("H2-recipient-lock-off", S + "store.ts", 'if (caps.recipient !== null) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340463))", [`comms-cap-recipient|${tenantId}|${entry.channel}|${entry.recipient_hash}`]);', "", [[CR]]),
 ("M2-best-link-probe", S + "funnel.ts", "const pool = matching.some(isRelationshipEvidence) ? matching.filter(isRelationshipEvidence) : matching;", "const pool = matching;", [[C + "zz-g1-review-a3b.test.ts"]]),
 ("N3-provider-id-dropped", S + "funnel.ts", "...(providerMessageId !== undefined ? { provider_message_id: providerMessageId } : {}), ", "", [[OI]]),
]
def run(files, timeout=600):
    cmd = "export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH; cd %s && pnpm exec vitest run %s --maxWorkers=2" % (WT, " ".join(files))
    p = subprocess.run(["su", "postgres", "-s", "/bin/bash", "-c", cmd], capture_output=True, text=True, timeout=timeout)
    return p.stdout + p.stderr
def summarize(text):
    fails = re.findall(r"^\s*(?:×|FAIL)\s+(.*)$", text, re.M)
    tot = re.findall(r"Tests\s+(.*)", text)
    return {"tests": tot[-1].strip()[:60] if tot else "?", "failed_lines": [f.strip()[:140] for f in fails][:4]}
only = set(sys.argv[1:])
for mid, f, find, rep, stages in M:
    if only and mid not in only: continue
    path = os.path.join(WT, f)
    src = open(path, encoding="utf-8").read()
    n = src.count(find)
    if n != 1:
        print(json.dumps({"id": mid, "status": "BAD_PATTERN", "count": n}), flush=True); continue
    killed_by = None; summary = None
    try:
        open(path, "w", encoding="utf-8").write(src.replace(find, rep)); import time; time.sleep(1.2)
        for st in stages:
            out = run(st)
            open(os.path.join(OUT, mid + "." + os.path.basename(st[0]) + ".log"), "w").write(out)
            s = summarize(out)
            if "failed" in s["tests"] or "FAIL" in out:
                killed_by = [os.path.basename(x) for x in st]; summary = s; break
    finally:
        subprocess.run(["git", "-C", WT, "checkout", "--", f], check=True)
    r = {"id": mid, "status": "KILLED" if killed_by else "SURVIVED", "by": killed_by, "summary": summary}
    print(json.dumps(r, ensure_ascii=False), flush=True)
