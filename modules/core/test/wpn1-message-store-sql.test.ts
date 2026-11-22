import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { MessageStore } from "../src/services/message-store.ts";
import { MainMessageStore } from "./support/main-message-store.ts";

/**
 * WP-N1 (fiks-runde 1, F-A3/D07): flagg AV på lagringslaget. En FALSK pool tar opp HVER setning (tekst + parametere) som `MessageStore.save` utfører, for grenens klasse og for en ordrett kopi av main sin klasse
 * (`support/main-message-store.ts`). Meldings-id/UUID normaliseres. Flagg AV (3 argumenter, tom opts, `{ restricted: false }`, `{ restricted: undefined }`) skal gi NØYAKTIG samme setningsfølge som main; ethvert annet valg
 * (fail-closed, I2) gir en begrenset INSERT. Uten denne testen kunne SQL-teksten til flagg-AV-grenen endres uten at noen N1-test falt (mutant D07).
 */
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? x.replace(/msg-[0-9a-f-]{36}/g, "msg-<uuid>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>") : x)));

function recorder(): { pool: pg.Pool; log: Array<{ text: string; params: unknown[] }> } {
  const log: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => { log.push({ text: text.replace(/\s+/g, " ").trim(), params }); return { rows: [{ message_id: "m", role: "user", content: "c", created_at: "t", restricted: false }], rowCount: 1 }; },
    release: () => undefined
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, log };
}
type Saver = { save: (...a: unknown[]) => Promise<string> };

describe("flagg AV: lagringssetningene er identiske med main", () => {
  for (const [name, call] of [
    ["save(user) med 3 argumenter", (s: Saver) => s.save(identity, "user", "hei")],
    ["save(assistant) med 3 argumenter", (s: Saver) => s.save(identity, "assistant", "svar")],
    ["save med {} (tom opts)", (s: Saver) => s.save(identity, "assistant", "svar", {})],
    ["save med {restricted:false}", (s: Saver) => s.save(identity, "assistant", "svar", { restricted: false })],
    ["save med {restricted: undefined}", (s: Saver) => s.save(identity, "assistant", "svar", { restricted: undefined })],
    ["save med opts: undefined", (s: Saver) => s.save(identity, "assistant", "svar", undefined)]
  ] as const) {
    it(name, async () => {
      const a = recorder();
      const b = recorder();
      await call(new MessageStore(a.pool) as unknown as Saver);
      await call(new MainMessageStore(b.pool) as unknown as Saver);
      expect(norm(a.log)).toEqual(norm(b.log));
      expect(a.log.length).toBeGreaterThan(3); // BEGIN, set_config, INSERT, audit, COMMIT
      expect(a.log.find((l) => l.text.startsWith("INSERT INTO messages"))!.text).toBe("INSERT INTO messages (message_id, tenant_id, session_id, role, content) VALUES ($1, $2, $3, $4, $5)");
    });
  }

  it("kontroll: med restricted:true avviker setningene (testen er ikke tom) - og INSERT-en bærer kolonnen, revisjonen {role, restricted:true}", async () => {
    const a = recorder();
    const b = recorder();
    await new MessageStore(a.pool).save(identity, "assistant", "svar", { restricted: true });
    await new MainMessageStore(b.pool).save(identity, "assistant", "svar");
    expect(norm(a.log)).not.toEqual(norm(b.log));
    expect(a.log.find((l) => l.text.startsWith("INSERT INTO messages"))!.text).toBe("INSERT INTO messages (message_id, tenant_id, session_id, role, content, restricted) VALUES ($1, $2, $3, $4, $5, true)");
    const payloads = a.log.filter((l) => l.text.includes("audit_events")).flatMap((l) => l.params).filter((p): p is string => typeof p === "string" && p.startsWith("{")).map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(payloads.some((p) => p["role"] === "assistant" && p["restricted"] === true)).toBe(true);
    expect(JSON.stringify(payloads)).not.toContain("svar"); // aldri innhold i revisjonen
  });

  it("I2 fail-closed: «true», 1, null, 0, tom streng, {} og [] gir den begrensede INSERT-en (kun undefined og false gir main sin setning)", async () => {
    for (const value of ["true", "false", 1, 0, "", null, {}, []]) {
      const a = recorder();
      await new MessageStore(a.pool).save(identity, "assistant", "svar", { restricted: value as never });
      expect(a.log.find((l) => l.text.startsWith("INSERT INTO messages"))!.text, JSON.stringify(value)).toContain("restricted) VALUES");
    }
  });

  it("history(): SQL-teksten er ENESTE avvik fra main (kolonnen restricted er med) - dokumentert flagg-AV-forskjell som krever migrasjon 140", async () => {
    const a = recorder();
    const b = recorder();
    await new MessageStore(a.pool).history(identity, 20);
    await new MainMessageStore(b.pool).history(identity, 20);
    const sel = (l: Array<{ text: string }>) => l.find((x) => x.text.startsWith("SELECT message_id"))!.text;
    expect(sel(a.log)).toBe(sel(b.log).replace("created_at FROM", "created_at, restricted FROM"));
    expect(a.log.map((l) => l.params)).toEqual(b.log.map((l) => l.params)); // parametrene er like
  });
});
