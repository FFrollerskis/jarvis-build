#!/usr/bin/env python3
# Reviewer A delta: mutasjoner mot fiks-runden (d79b0434). Mutasjonen settes inn midlertidig og gjenopprettes ALLTID med `git checkout -- <fil>`.
import subprocess, sys, json, os, re
WT = "/home/user/jarvisbuild/.claude/worktrees/agent-aea9aa2c106dc3965"
OUT = "/tmp/claude-0/-home-user-jarvisbuild/f781b90f-9fc6-545a-b2ea-055acc984b23/scratchpad/rev-a2/mut"
os.makedirs(OUT, exist_ok=True)
C = "modules/comms/test/"
CAPS = C + "caps-atomic.test.ts"
CONC = C + "zz-g1-review-a-conc.test.ts"
PB = C + "purpose-basis.test.ts"
SS = C + "stop-scope.test.ts"
SA = C + "stop-atomic.test.ts"
OI = C + "outbound-integrity.test.ts"
DM = C + "disclosure-media.test.ts"
LF = C + "low-fixes.test.ts"
MF = C + "manifest-all-flags.test.ts"
ADX = C + "adapters-extra.test.ts"
S = "modules/comms/src/"
M = [
 # ---- fiks-runden: A-H2 (atomiske tak)
 ("H2-recipient-lock-off", S + "store.ts", 'if (caps.recipient !== null) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340463))", [`comms-cap-recipient|${tenantId}|${entry.channel}|${entry.recipient_hash}`]);', "", [[CAPS], [CONC]]),
 ("H2-account-lock-off", S + "store.ts", 'await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340463))", [`comms-cap-account|${tenantId}|${entry.channel}|${entry.account_ref}`]);', "", [[CAPS]]),
 ("H2-recount-recipient-off", S + "store.ts", "(await this.recipientCount(client, tenantId, entry.channel, entry.recipient_hash, caps.recipient.kind, now)) >= caps.recipient.limit", "false", [[CAPS]]),
 ("H2-recount-account-off", S + "store.ts", "(await this.accountCount(client, tenantId, entry.channel, entry.account_ref, now)) >= caps.account.limit", "false", [[CAPS]]),
 # ---- fiks-runden: A-M2
 ("M2-basis-required-off", S + "policy.ts", 'deny("purpose_basis", "purpose_basis_required")', 'add("purpose_basis", "not_applicable")', [[PB]]),
 ("M2-basis-call-exempt", S + "policy.ts", 'if (!isMessageLike) {\n    add("purpose_basis", "not_applicable");', 'if (!isMessageLike || request.kind === "call") {\n    add("purpose_basis", "not_applicable");', [[PB]]),
 # ---- fiks-runden: A-M3/M7
 ("M3-tel-ns-no-whatsapp", S + "channels.ts", 'channel === "sms" || channel === "whatsapp" || channel === "phone" ? "tel" : channel', 'channel === "sms" || channel === "phone" ? "tel" : channel', [[SS]]),
 ("M3-start-any-channel", S + "store.ts", "WHERE tenant_id = $1 AND channel = $2 AND recipient_hash = $3 AND status = 'active' AND source IN ('inbound_stop_keyword', 'provider_error')", "WHERE tenant_id = $1 AND $2::text IS NOT NULL AND recipient_hash = $3 AND status = 'active' AND source IN ('inbound_stop_keyword', 'provider_error')", [[SS]]),
 ("M3-start-any-source", S + "store.ts", "AND status = 'active' AND source IN ('inbound_stop_keyword', 'provider_error')", "AND status = 'active'", [[SS]]),
 ("M7-unauth-stop-ignored", S + "webhooks/ingest.ts", 'if (account === null && keyword !== "stop") {', "if (account === null) {", [[SS]]),
 ("M7-optout-acct-validate-off", S + "transport.ts", 'if (p.account_ref !== undefined && p.account_ref !== "*" && !isValidAccountRef(p.channel, p.account_ref)) throw new Error("comms_invalid_parameters:account_ref_invalid");', "", [[SS]]),
 # ---- fiks-runden: A-M4/M5/M6
 ("M4-afterAccepted-off", S + "funnel.ts", 'await afterAcceptedMutation("comms_journal_settle_failed", () => store.settleAttempt(', 'await ((_c: string, f: () => Promise<unknown>) => f())("comms_journal_settle_failed", () => store.settleAttempt(', [[OI]]),
 ("M5-fingerprint-no-recipient", S + "funnel.ts", "request.kind, request.channel, request.account_ref, request.recipient, request.purpose,", "request.kind, request.channel, request.account_ref, request.purpose,", [[OI]]),
 ("M5-collision-off", S + "owner-actions.ts", 'if (state === "collision") return { ok: false, status: "rejected", reason: "idempotency_key_collision" };', "", [[OI]]),
 ("M6-edit-marketing-off", S + "policy.ts", 'if ((isMessageLike || request.kind === "edit") && request.purpose !== "marketing") {', 'if (isMessageLike && request.purpose !== "marketing") {', [[OI]]),
 # ---- fiks-runden: A-M1/L3/L4/A-H1
 ("M1-audio-text-off", S + "adapters.ts", 'await this.postWithId(request, token, { type: "text", text: { body: request.text, preview_url: false } });\n        try {', "try {", [[DM]]),
 ("L3-canonical-url-off", S + "policy.ts", ' && !media.url.includes("\\\\") && url.href === media.url ?', ' && !media.url.includes("\\\\") ?', [[DM]]),
 ("L4-xmlsafe-off", S + "adapters.ts", 'if (!isXmlSafe(request.script)) throw new Error("comms_twiml_invalid_character");', "", [[DM]]),
 ("H1-override-off", "modules/tool-gateway/src/tool-manifest.ts", '[k("comms", "contacts_list")]: "read",', "", [[MF]]),
 # ---- de seks overlevende fra runde 1
 ("QH-1", S + "policy.ts", "return start < end ? hour >= start && hour < end : hour >= start || hour < end;", "return start < end ? hour >= start && hour < end : hour > start || hour < end;", [[LF]]),
 ("RL-1", S + "store.ts", "const since = new Date(now.getTime() - 24 * 3_600_000);", "const since = new Date(now.getTime() - 1 * 3_600_000);", [[CAPS]]),
 ("RL-4", S + "store.ts", 'const ACTIVE_STATUSES = ["requested", "sent", "outcome_unknown"];', 'const ACTIVE_STATUSES = ["sent"];', [[CAPS]]),
 ("WIN-1", S + "store.ts", "AND sender_hash = $3 AND kind = 'message' AND account_ref IN ($4, '*')", "AND sender_hash = $3 AND account_ref IN ($4, '*')", [[LF]]),
 ("TGT-2", S + "store.ts", "WHERE tenant_id = $1 AND channel = $2 AND provider_message_id = $3 AND kind = 'message' AND status = 'sent' ORDER BY created_at DESC LIMIT 1", "WHERE tenant_id = $1 AND channel = $2 AND provider_message_id = $3 ORDER BY created_at DESC LIMIT 1", [[LF]]),
 ("SAFE-1", S + "funnel.ts", 'return SAFE_ERROR.test(message) ? message : "comms_unspecified_error";', "return message;", [[LF]]),
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
        open(path, "w", encoding="utf-8").write(src.replace(find, rep))
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
