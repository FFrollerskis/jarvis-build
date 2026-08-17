import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";

/**
 * UA-2 P1B-A §2: `email`/`list_messages` og `email`/`read_attachment` ble lagt
 * til på SLUTTEN av `firstWaveTools()`-arrayet (samme konvensjon som alle
 * tidligere tillegg - eksisterende tester indekserer posisjonelt, se
 * `fase7-tools.test.ts` sin `firstWaveTools({ email })[4]`-bruk av den
 * OPPRINNELIGE `email/read_inbox`-oppføringen, som denne suiten beviser er
 * UENDRET på indeks 4).
 */
describe("email/list_messages + email/read_attachment - nye ToolDefinitions (UA-2 P1B-A)", () => {
  it("A: begge finnes i firstWaveTools() med korrekt tool_id/action", () => {
    const defs = firstWaveTools();
    const listMessages = defs.find((d) => d.tool_id === "email" && d.action === "list_messages");
    const readAttachment = defs.find((d) => d.tool_id === "email" && d.action === "read_attachment");
    expect(listMessages).toBeDefined();
    expect(readAttachment).toBeDefined();
  });

  it("B: begge er kapabilitetsklasse A (lesing), untrusted output, JARVIS_EMAIL_TOKEN - SAMME credential som read_inbox/send, ingen ny credential-type", () => {
    const defs = firstWaveTools();
    for (const action of ["list_messages", "read_attachment"]) {
      const def = defs.find((d) => d.tool_id === "email" && d.action === action);
      expect(def?.capability_class, action).toBe("A");
      expect(def?.output_trust, action).toBe("untrusted");
      expect(def?.credential_ref, action).toBe("JARVIS_EMAIL_TOKEN");
      expect(def?.reversible, action).toBe(true);
      expect(def?.idempotent_external, action).toBe(true);
    }
  });

  it("C: den OPPRINNELIGE email/read_inbox-oppføringen forblir uendret på indeks 4 - nye handlinger forskyver INGEN eksisterende posisjonelle tester", () => {
    const defs = firstWaveTools();
    expect(defs[4]?.tool_id).toBe("email");
    expect(defs[4]?.action).toBe("read_inbox");
  });

  it("D: read_attachment sitt input_schema krever BÅDE message_id og attachment_id (strict - ingen ekstra felter tillatt)", () => {
    const defs = firstWaveTools();
    const def = defs.find((d) => d.tool_id === "email" && d.action === "read_attachment");
    const parsed = def?.input_schema.safeParse({ message_id: "m1", attachment_id: "a1" });
    expect(parsed?.success).toBe(true);
    expect(def?.input_schema.safeParse({ message_id: "m1" }).success).toBe(false);
    expect(def?.input_schema.safeParse({ message_id: "m1", attachment_id: "a1", extra: "x" }).success).toBe(false);
  });

  it("E: list_messages sitt input_schema tillater valgfri query, krever max innenfor 1-50", () => {
    const defs = firstWaveTools();
    const def = defs.find((d) => d.tool_id === "email" && d.action === "list_messages");
    expect(def?.input_schema.safeParse({ max: 10 }).success).toBe(true);
    expect(def?.input_schema.safeParse({ max: 10, query: "has:attachment" }).success).toBe(true);
    expect(def?.input_schema.safeParse({ max: 0 }).success).toBe(false);
    expect(def?.input_schema.safeParse({ max: 51 }).success).toBe(false);
    expect(def?.input_schema.safeParse({}).success).toBe(false);
  });

  it("F: begge bruker samme delte 'email'-transport-nøkkel som read_inbox/send - ingen ny transport-type", () => {
    class Probe {
      calls: string[] = [];
      async invoke(action: string) {
        this.calls.push(action);
        return { data: {} };
      }
    }
    const probe = new Probe();
    const defs = firstWaveTools({ email: probe });
    const listMessages = defs.find((d) => d.tool_id === "email" && d.action === "list_messages");
    const readAttachment = defs.find((d) => d.tool_id === "email" && d.action === "read_attachment");
    expect(listMessages?.transport).toBe(probe);
    expect(readAttachment?.transport).toBe(probe);
  });
});
