import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { writeAudit } from "../src/services/audit-writer.ts";
import { toPolicyDecisionRow } from "../src/services/policy-audit-sink.ts";
import { clipRedacted, redactForLog, redactLogText, scanForSecrets } from "../src/services/secret-scan.ts";
import { body, pemBegin, pemEnd, tok } from "./support/secret-fixtures.ts";

/**
 * WP-SEC2 fiks-runde 1, lagring/integrasjon i kjernen (review B: M2, M3-A3, L1, L3). Alle verdier bygges sammensatt ved kjøring.
 */
const M = (kind: string): string => `[REDACTED:${kind}]`;
const identity = { person_id: "p1", tenant_id: "t1", session_id: "s1", device_id: "d1" };

function fakeClient(): { client: pg.PoolClient; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params?: unknown[]) => { calls.push({ sql: String(sql), params: params ?? [] }); return { rows: [], rowCount: 0 }; }, release: () => undefined } as unknown as pg.PoolClient;
  return { client, calls };
}
async function audit(entry: Record<string, unknown>): Promise<{ reason: unknown; payload: Record<string, unknown>; params: unknown[] }> {
  const { client, calls } = fakeClient();
  await writeAudit(client, identity, entry as never);
  const params = (calls[0] as { params: unknown[] }).params;
  return { reason: params[6], payload: JSON.parse(params[10] as string) as Record<string, unknown>, params };
}

afterEach(() => vi.restoreAllMocks());

describe("B-M2 (regresjon mot base): en UUID i nabolaget gjør ikke et ekte kortnummer til en del av UUID-en", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const cardCases: Array<[string, string]> = [
    ["kort + mellomrom + UUID", `kort 4111 1111 1111 1111 ${uuid}`],
    ["<kort>-<uuid>", `4111111111111111-${uuid}`],
    ["<uuid>-<kort>", `${uuid}-4111111111111111`],
    ["kort + (id <uuid>)", `4111111111111111 (id ${uuid})`],
    ["ref=<uuid> kort <kort>", `ref=${uuid} kort 4111111111111111`]
  ];
  for (const [label, text] of cardCases) {
    it(`${label}: kortet redigeres, UUID-en står uredigert`, () => {
      const r = scanForSecrets(text);
      expect(r.findings, text).toEqual([{ kind: "card_number", count: 1 }]);
      expect(r.text, text).not.toContain("4111");
      expect(r.text, text).toContain(uuid);
    });
  }
  it("fin-pi-id-ene og UUID-er med bare sifre i første gruppene står fortsatt uredigert (overlapp-regelen, ikke nærhet)", () => {
    const luhnUuid = ["41111111", "1111", "1111", "9111", "111111111111"].join("-");
    for (const text of ["fin-pi-47015187-4988-4107-9302-123456789012", `tool_failed:possible_duplicate_of:${luhnUuid}`, `id=${luhnUuid.toUpperCase()}`, luhnUuid]) expect(scanForSecrets(text), text).toEqual({ text, findings: [] });
  });
});

describe("B-L3: skann FØR kutt - et token bak en stor skjult blokk blir ikke et halvt token", () => {
  /** En privat nøkkel-blokk som fyller opp til `keep` tegn før 64K-grensen, så tokenet: grensen ville kuttet tokenet etter `keep` tegn. */
  function tokenBehindBlock(keep: number): { text: string; token: string } {
    const token = tok.github();
    const CAP = 65_536;
    const head = `${pemBegin()}\n`;
    const tail = `\n${pemEnd()}`;
    const middle = body(64, 1).repeat(Math.ceil(CAP / 64)).slice(0, CAP - keep - 1 - head.length - tail.length);
    return { text: `${head}${middle}${tail} ${token}`, token };
  }
  it("redactForLog (tidligere 64 KB-kutt før skanning): hele blokken og hele tokenet er redigert, ingen token-rest", () => {
    const { text, token } = tokenBehindBlock(15);
    const out = redactForLog(text, 300);
    expect(out).toBe(`${M("private_key")} ${M("github_token")}`);
    expect(out).not.toContain(token.slice(0, 8));
  });
  it("policy-sinken (reason, tidligere 64 KB-kutt før skanning): samme resultat", () => {
    const { text, token } = tokenBehindBlock(15);
    const event = { tenant_id: "t1", decision: "DENY", decision_id: "dec-000001", at: "2026-11-26T10:00:00Z", reason: text, person_id: "p1", tool_id: "t", action: "a", capability_class: "A" };
    const row = toPolicyDecisionRow(event as never, null, new Date("2026-11-26T10:00:00Z"));
    expect(typeof row).toBe("object");
    expect((row as { reason: string }).reason).toBe(`${M("private_key")} ${M("github_token")}`);
    expect((row as { reason: string }).reason).not.toContain(token.slice(0, 8));
  });
  it("clipRedacted er skann-først (også når kuttet faller midt i tokenet)", () => {
    const token = tok.github();
    expect(clipRedacted(`${"x".repeat(10)} ${token}`, 20)).toBe(`${"x".repeat(10)} ${M("github_token")}`.slice(0, 20));
    expect(clipRedacted(token, 8)).toBe(M("github_token").slice(0, 8));
  });
  it("redactLogText og redactForLog beholder atferden for vanlig tekst og kutter først til slutt", () => {
    expect(redactForLog(new Error(`feil ${tok.github()}`), 200)).toBe(`Error: feil ${M("github_token")}`);
    expect(redactLogText("Authorization: Bearer abc")).toBe("Authorization: [REDACTED]");
  });
});

describe("B-M3/B-L1: writeAudit fail-closed er testet, loggført og beholder nøkler/ikke-strenger", () => {
  it("en reason som ikke kan skannes (toString kaster): nyttelastens tall/boolean/null beholdes, strenger/objekter blir markør, ingen rå verdi lagres, og feilen logges UTEN innhold", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = tok.github();
    const r = await audit({
      type: "x.test", reason: { toString() { throw new Error(`boom ${secret}`); } },
      payload: { keep: 7, flag: true, nothing: null, note: `bruk ${secret}`, nested: { password: secret }, list: [secret] }
    });
    expect(r.reason).toBeNull();
    expect(r.payload).toEqual({ keep: 7, flag: true, nothing: null, note: M("redaction_failed"), nested: M("redaction_failed"), list: M("redaction_failed"), redaction_failed: true });
    expect(JSON.stringify(r.params)).not.toContain(secret.slice(4, 24));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({ msg: "audit_redaction_failed", type: "x.test", error: "Error" });
    expect(logged).not.toContain(secret.slice(4, 24));
  });
  it("et nøkkelnavn som er en hemmelighet skannes også i fail-closed-nyttelasten, og en payload-getter som kaster gir kun `redaction_failed`", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = tok.github();
    const r1 = await audit({ type: "x", reason: { toString() { throw new Error("x"); } }, payload: { [secret]: 1 } });
    expect(Object.keys(r1.payload)).toEqual([M("github_token"), "redaction_failed"]);
    const entry = { type: "x", reason: { toString() { throw new Error("x"); } }, get payload(): Record<string, unknown> { throw new Error("payload"); } };
    const r2 = await audit(entry);
    expect(r2.payload).toEqual({ redaction_failed: true });
  });
  it("reason=null, reason=tall og tomt payload (JS-kallere) gir IKKE redaction_failed: nyttelasten skannes og lagres som vanlig", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = tok.github();
    const a = await audit({ type: "x", reason: null, payload: { keep: "viktig", n: 1 } });
    expect(a.reason).toBeNull();
    expect(a.payload).toEqual({ keep: "viktig", n: 1 });
    const b = await audit({ type: "x", reason: 123, payload: { keep: "viktig", leak: secret } });
    expect(b.reason).toBe("123");
    expect(b.payload).toEqual({ keep: "viktig", leak: M("github_token"), secret_redacted: ["github_token"] });
    expect(errorSpy).not.toHaveBeenCalled();
  });
  it("uten funn og uten feil er reason og nyttelast BYTE-IDENTISK med innsendt (flagg AV-atferd)", async () => {
    const r = await audit({ type: "x", reason: "alt ok", payload: { a: 1, b: "to", c: [1, "tre"], d: { e: null } } });
    expect(r.reason).toBe("alt ok");
    expect(r.payload).toEqual({ a: 1, b: "to", c: [1, "tre"], d: { e: null } });
  });
});

describe("B-L7: redactLogText hopper over det super-lineære mønsteret når teksten ikke har `:`/`=` (atferd uendret)", () => {
  it("«KEY»×170 000 og «API_KEY_»×62 500 (tidligere 1,9 s og 0,8 s) går raskt, og redigeringen er den samme som før", () => {
    for (const text of ["KEY".repeat(170_000), "API_KEY_".repeat(62_500)]) {
      const started = Date.now();
      expect(redactLogText(text)).toBe(text);
      expect(Date.now() - started).toBeLessThan(400);
    }
    expect(redactLogText(`feil: API_KEY=${["gh", "p_"].join("")}${body(36)} og TOKEN: hemmelig123`)).toBe("feil: API_KEY=[REDACTED] og TOKEN: [REDACTED]");
    expect(redactLogText("Bearer abc.def-ghi og Authorization: Basic xyz")).toBe("Bearer [REDACTED] og Authorization: [REDACTED]");
    expect(redactLogText(`rotasjon ${["sk", "-ant-"].join("")}${body(20)} feilet`)).toBe("rotasjon [REDACTED_ANTHROPIC_KEY] feilet");
  });
});
