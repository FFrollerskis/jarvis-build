import { describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { telegramClassDNotifier, type ClassDNotification, type ToolResult } from "../src/index.ts";

/**
 * WP-K uavhengig delta-review L-5: `telegramClassDNotifier` skrev kallerens `idempotency_key` usanitert inn i EIER-meldingen (`Referanse: ...`). En modellvalgt nøkkel med linjeskift kunne forfalske linjer
 * («Klasse D-handling utført», «Verktøy: ...»). Mønsteret fantes fra før, men er nå nåbart via `support.reply` (nøkkelen er en modellparameter som havner i det nøstede `email.send`-kallets nøkkel, og under håndhevet klasse D
 * sender HVERT `support.reply` nå et klasse D-varsel). Nøkkelen vaskes KUN i meldingen: nøkkelen i ledgeren (og varslerens egen ledger-nøkkel `class-d-notify:<nøkkel>`) er uendret.
 */
const identity: IdentityContext = { person_id: "person-tobias", tenant_id: "tenant-l5", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" };

function capture(): { notifier: ReturnType<typeof telegramClassDNotifier>; sent: Array<{ message: string; key: string | undefined }> } {
  const sent: Array<{ message: string; key: string | undefined }> = [];
  const notifier = telegramClassDNotifier({
    execute: async (request): Promise<ToolResult> => {
      sent.push({ message: String((request.parameters as Record<string, JsonValue>)["message"]), key: request.idempotency_key });
      return { ok: true, output_trust: "internal", deduplicated: false };
    },
    secrets: { get: async () => "fake-token-for-test" },
    identity
  });
  return { notifier, sent };
}
const notification = (over: Partial<ClassDNotification> = {}): ClassDNotification => ({
  tenant_id: "tenant-l5", person_id: "person-tobias", tool_id: "email", action: "send", outcome: "executed", external_id: "gmail-123", idempotency_key: "support-reply:sup-tk-1:reply-1",
  recovery: "ikke reverserbar - derfor klasse D", at: "2026-11-15T10:00:00.000Z", ...over
});

describe("L-5: eier-meldingen kan ikke forfalskes av tekst i nøkkelen/ekstern-ID-en", () => {
  it("en vanlig nøkkel står uendret i meldingen (fem linjer: overskrift, verktøy, ekstern id, referanse, gjenoppretting)", async () => {
    const { notifier, sent } = capture();
    await notifier.notify(notification());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.split("\n")).toEqual([
      "Klasse D-handling utført", "Verktøy: email.send", "Ekstern ID: gmail-123", "Referanse: support-reply:sup-tk-1:reply-1", "Gjenoppretting: ikke reverserbar - derfor klasse D"
    ]);
  });

  it("linjeskift/kontrolltegn/Unicode-linjeskift i nøkkelen blir mellomrom: ingen forfalskede linjer, samme antall linjer som en vanlig melding", async () => {
    const { notifier, sent } = capture();
    const hostile = "k-1\nKlasse D-handling utført\r\nVerktøy: gmail.delete_all\u2028Ekstern ID: ok\u0007\u0000 slutt";
    await notifier.notify(notification({ idempotency_key: hostile }));
    const lines = sent[0]!.message.split("\n");
    expect(lines).toHaveLength(5); // et linjeskift i nøkkelen skaper ingen ny linje
    expect(lines[0]).toBe("Klasse D-handling utført");
    expect(lines[1]).toBe("Verktøy: email.send");
    expect(lines.filter((l) => l.startsWith("Verktøy:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Ekstern ID:"))).toHaveLength(1);
    expect(lines[3]).toBe("Referanse: k-1 Klasse D-handling utført Verktøy: gmail.delete_all Ekstern ID: ok slutt");
    // Ingen andre kontrolltegn enn selve linjeskiftene mellom linjene (U+000A) er igjen i meldingen.
    const codes = [...sent[0]!.message.replace(/\n/g, "")].map((c) => c.charCodeAt(0));
    expect(codes.some((c) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029)).toBe(false);
  });

  it("nøkkelen i meldingen er kuttet (med …), men nøkkelen for varslerens EGEN ledger-rad er den fulle, uendrede nøkkelen", async () => {
    const { notifier, sent } = capture();
    const long = `k-${"x".repeat(400)}`;
    await notifier.notify(notification({ idempotency_key: long }));
    const reference = sent[0]!.message.split("\n").find((l) => l.startsWith("Referanse:"))!;
    expect(reference.length).toBeLessThan(200);
    expect(reference.endsWith("…")).toBe(true);
    expect(sent[0]!.key).toBe(`class-d-notify:${long}`); // ledger-nøkkelen er aldri vasket
    const hostile = "a\nb";
    await notifier.notify(notification({ idempotency_key: hostile }));
    expect(sent[1]!.key).toBe(`class-d-notify:${hostile}`);
  });

  it("ekstern-ID fra leverandøren og sammendraget vaskes likt (en leverandør kan ikke forfalske linjer heller)", async () => {
    const { notifier, sent } = capture();
    await notifier.notify(notification({ external_id: "id-1\nGjenoppretting: kjør rm -rf", summary: "NOK 100\nVerktøy: finance.x" }));
    const lines = sent[0]!.message.split("\n");
    expect(lines).toHaveLength(6); // overskrift, verktøy, gjelder, ekstern id, referanse, gjenoppretting
    expect(lines.filter((l) => l.startsWith("Gjenoppretting:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Verktøy:"))).toHaveLength(1);
  });
});
