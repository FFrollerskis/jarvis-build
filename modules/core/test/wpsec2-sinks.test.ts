import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { MessageStore } from "../src/services/message-store.ts";
import { writeAudit } from "../src/services/audit-writer.ts";
import { toPolicyDecisionRow } from "../src/services/policy-audit-sink.ts";
import { clipRedacted, redactForLog, redactLogText, scanForSecrets } from "../src/services/secret-scan.ts";
import { HIDDEN, body, insertAt, tok } from "./support/secret-fixtures.ts";

/**
 * WP-SEC2 (K7): ALLE lagringssteder for fritekst går via skanneren. `writeAudit` (reason + nyttelast, strukturert), `MessageStore.save` (alle roller), kutt-etter-skann (policy-sink, `clipRedacted`), `redactForLog` og
 * `redactLogText` (felles for driftslogger; `incidents/redact.ts` og `docker-transport.ts` har ingen egne mønsterkopier lenger).
 */
const M = (kind: string): string => `[REDACTED:${kind}]`;
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };

/** Fanger parametrene til hver spørring. */
function fakeClient(): { client: pg.PoolClient; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params?: unknown[]) => { calls.push({ sql: String(sql), params: params ?? [] }); return { rows: [], rowCount: 0 }; }, release: () => undefined } as unknown as pg.PoolClient;
  return { client, calls };
}
const auditParams = (calls: Array<{ sql: string; params: unknown[] }>): { reason: unknown; payload: unknown } => {
  const call = calls.find((c) => c.sql.includes("INSERT INTO audit_events"));
  expect(call).toBeDefined();
  return { reason: (call as { params: unknown[] }).params[6], payload: JSON.parse((call as { params: unknown[] }).params[10] as string) as unknown };
};

describe("K7b: writeAudit skanner reason og nyttelast sentralt (strukturert)", () => {
  it("reason og nyttelast redigeres: token i fritekst, hemmelig nøkkelnavn, skjult og delt token, JSON-streng i nyttelasten; typene (aldri verdiene) listes i `secret_redacted`", async () => {
    const { client, calls } = fakeClient();
    const token = tok.github();
    await writeAudit(client, identity, {
      type: "tool.failed", decision: "DENY", reason: `leverandøren svarte: ${token}`, tool_id: "x.y", action: "z",
      payload: {
        note: `bruk ${insertAt(token, 9, HIDDEN.zwsp)} her`, password: "enkelt-ord", split: [token.slice(0, 4), token.slice(4)], json: JSON.stringify({ api_key: body(20) }),
        nested: { client_secret: body(20), fine: "vanlig tekst", token_count: 12 }
      }
    });
    const { reason, payload } = auditParams(calls);
    const text = JSON.stringify({ reason, payload });
    expect(text).not.toContain(token.slice(4, 30));
    expect(text).not.toContain("enkelt-ord");
    expect(text).not.toContain(body(20));
    expect(reason).toBe(`leverandøren svarte: ${M("github_token")}`);
    const p = payload as Record<string, unknown>;
    expect(p["fine"] ?? (p["nested"] as Record<string, unknown>)["fine"]).toBe("vanlig tekst");
    expect((p["nested"] as Record<string, unknown>)["token_count"]).toBe(12);
    expect(p["password"]).toBe(M("named_secret"));
    expect(p["secret_redacted"]).toEqual(expect.arrayContaining(["github_token", "named_secret"]));
  });

  it("en nyttelast uten hemmeligheter er BYTE-IDENTISK med før (samme JSON), og reason uten funn er uendret", async () => {
    const { client, calls } = fakeClient();
    const payload = { credential_ref: "INFISICAL:github", external_id: "42", scopes: ["repo", "workflow"], rollback: "cloudflare.update_dns_record med feltene fra before_state", before_state: { id: "a", content: "v=spf1 -all", ttl: 300 }, replayed: false, token_count: 3, hash: "0123456789abcdef".repeat(4) };
    await writeAudit(client, identity, { type: "tool.executed", reason: "postcondition_unverified:replayed", payload });
    const params = (calls.find((c) => c.sql.includes("INSERT INTO audit_events")) as { params: unknown[] }).params;
    expect(params[10]).toBe(JSON.stringify(payload));
    expect(params[6]).toBe("postcondition_unverified:replayed");
    const none = fakeClient();
    await writeAudit(none.client, identity, { type: "x" });
    const p = (none.calls.find((c) => c.sql.includes("INSERT INTO audit_events")) as { params: unknown[] }).params;
    expect(p[6]).toBeNull();
    expect(p[10]).toBe("{}");
  });

  it("selve nøkkelen i en nyttelast kan være en hemmelighet, og for dype/sykliske nyttelaster gir fail-closed markør i stedet for en kastet feil", async () => {
    const { client, calls } = fakeClient();
    const token = tok.aws();
    const cyc: Record<string, unknown> = { a: 1 };
    cyc["self"] = cyc;
    await writeAudit(client, identity, { type: "t", payload: { [token]: true, cyc } });
    const { payload } = auditParams(calls);
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(JSON.stringify(payload)).toContain(M("structure_limit"));
  });
});

describe("K7b: MessageStore.save skanner innholdet for ALLE roller", () => {
  function setup(): { store: MessageStore; calls: Array<{ sql: string; params: unknown[] }> } {
    const { client, calls } = fakeClient();
    const pool = { connect: async () => client, query: client.query } as unknown as pg.Pool;
    return { store: new MessageStore(pool), calls };
  }
  const inserted = (calls: Array<{ sql: string; params: unknown[] }>): string => String((calls.find((c) => c.sql.includes("INSERT INTO messages")) as { params: unknown[] }).params[4]);

  for (const role of ["assistant", "tool", "system", "user"] as const) {
    it(`${role}: en hemmelighet i teksten lagres aldri (skjult, delt eller JSON-form), og revisjonsraden nevner kun typer`, async () => {
      const { store, calls } = setup();
      const token = tok.github();
      const content = `svar: ${insertAt(token, 6, HIDDEN.zwj)} og {"password":"${body(12)}"}`;
      await store.save(identity, role, content);
      const stored = inserted(calls);
      expect(stored).toBe(`svar: ${M("github_token")} og {"password":"${M("named_secret")}"}`);
      const audit = auditParams(calls);
      expect(JSON.stringify(audit.payload)).not.toContain(token.slice(4, 20));
      expect((audit.payload as Record<string, unknown>)["secret_redacted"]).toEqual(["github_token", "named_secret"]);
    });
  }

  it("tekst uten hemmeligheter lagres BYTE-IDENTISK og revisjonsraden er som før (`{ role }`), også for begrensede rader", async () => {
    const { store, calls } = setup();
    const text = "Blåbærsyltetøy 👨‍👩‍👧 og token_count: 12\nlinje to";
    await store.save(identity, "assistant", text);
    expect(inserted(calls)).toBe(text);
    expect(auditParams(calls).payload).toEqual({ role: "assistant" });
    const restricted = setup();
    await restricted.store.save(identity, "assistant", `x ${tok.github()}`, { restricted: true });
    expect(inserted(restricted.calls)).toBe(`x ${M("github_token")}`);
    expect(auditParams(restricted.calls).payload).toEqual({ role: "assistant", restricted: true, secret_redacted: ["github_token"] });
  });
});

describe("K7b: skann FØRST, kutt etterpå", () => {
  it("clipRedacted: en hemmelighet som krysser kuttgrensen blir ikke et halvt token", () => {
    const token = tok.github();
    const text = `${"x".repeat(69)} ${token}`;
    expect(text.slice(0, 80)).toContain("ghp_"); // gammel rekkefølge: halvt token igjen
    const clipped = clipRedacted(text, 80);
    expect(clipped).not.toContain("ghp_");
    expect(clipped.startsWith("x".repeat(69))).toBe(true);
    expect(clipRedacted("kort tekst", 80)).toBe("kort tekst");
  });

  it("policy-sinken: reason med et token som krysser den gamle 4096-grensen eller har kontrolltegn midt i redigeres (kontrolltegn fjernes ETTER skanning)", () => {
    const token = tok.github();
    const event = (reason: string) => ({ tenant_id: "t1", decision: "DENY", decision_id: "dec-000001", at: "2026-11-26T10:00:00Z", reason, person_id: "p1", tool_id: "t", action: "a", capability_class: "A" });
    const row = (reason: string) => toPolicyDecisionRow(event(reason) as never, null, new Date("2026-11-26T10:00:00Z"));
    for (const reason of [`${" ".repeat(4090)}${token}`, `${token.slice(0, 12)}${HIDDEN.nul}${token.slice(12)}`, `${token.slice(0, 12)}\n${token.slice(12)}`, `${token.slice(0, 12)} ${token.slice(12)}`]) {
      const r = row(reason);
      expect(typeof r === "object" && r.reason, JSON.stringify(reason.slice(-60))).not.toContain("ghp_");
    }
  });
});

describe("K7c: redactForLog og K7d: redactLogText", () => {
  it("redactForLog tar Error, streng og vilkårlige verdier; skanner først, kutter sist, gir én linje og kaster aldri", () => {
    const token = tok.github();
    expect(redactForLog(new Error(`HTTP 401: ${token} avvist`))).toBe(`Error: HTTP 401: ${M("github_token")} avvist`);
    expect(redactForLog(`${"x".repeat(24)} ${token}`, 30)).not.toContain("ghp_");
    expect(redactForLog(["linje 1\nlinje 2", String.fromCodePoint(0x2028), "tre", String.fromCodePoint(0), "fire"].join(""))).toBe("linje 1 linje 2 tre fire");
    expect(redactForLog({ authorization: "Basic abc", n: 1 })).not.toContain("abc");
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(typeof redactForLog(cyc)).toBe("string");
    expect(redactForLog(undefined)).toBe("undefined");
    expect(redactForLog("a".repeat(1000), 50)).toHaveLength(50);
    expect(redactForLog("vanlig feil: tilkobling avbrutt")).toBe("vanlig feil: tilkobling avbrutt");
  });

  it("redactLogText redigerer minst like mye som sentralen, og beholder de gamle lokale formene (Bearer, Authorization-linje, NAVN=verdi)", () => {
    expect(redactLogText("calling API with Bearer abc123XYZ.def")).toBe("calling API with Bearer [REDACTED]");
    expect(redactLogText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]");
    expect(redactLogText("DB_PASSWORD=hunter2 startup complete")).toBe("DB_PASSWORD=[REDACTED] startup complete");
    expect(redactLogText("container started successfully, listening on port 8080")).toBe("container started successfully, listening on port 8080");
    const token = tok.github();
    const probes = [`x ${insertAt(token, 5, HIDDEN.zwsp)}`, `x ${token.slice(0, 20)}\n${token.slice(20)}`, `{"api_key":"${body(16)}"}`, `Cookie: sid=${body(16)}`, tok.pem(2), `Authorization: Digest username="u", nonce="${body(10)}"`, `${tok.sendgrid()}`];
    for (const probe of probes) {
      const central = scanForSecrets(probe);
      const local = redactLogText(probe);
      expect(central.findings.length, probe).toBeGreaterThan(0);
      expect(scanForSecrets(local).findings, `ikke svakere enn sentralen: ${probe}`).toEqual([]);
      for (const leak of [token.slice(6, 30), body(16), tok.sendgrid().slice(5, 30), body(64, 1)]) expect(local).not.toContain(leak);
    }
  });

  it("redactLogText er lineær: 500 KB uten nøkkelord og lange løper tar under 2 s", () => {
    for (const unit of ["a", "A_", "token-", "Bearer ", "Authorization:"]) {
      const text = unit.repeat(Math.ceil(500_000 / unit.length));
      const started = Date.now();
      redactLogText(text);
      expect(Date.now() - started, unit).toBeLessThan(2000);
    }
  });
});
