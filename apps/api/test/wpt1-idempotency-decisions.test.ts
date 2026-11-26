import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { isSelfRecoveryAction } from "@jarvis/policy";
import {
  CLASS_D_EXEMPT_ACTIONS, DIGEST_EXCLUDED_PARAMETERS, SECRET_LIKE_PARAMETER_NAME, SECRET_NAME_NOT_A_SECRET,
  KnowledgeSearchTransport, MemorySearchTransport, buildToolManifest, decideIdempotency, firstWaveTools, homeAssistantTools, inferEffect, isClassDExempt, isJarvisCoreNamespace,
  knowledgeToolDefinitions, memoryToolDefinitions, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * WP-T1 K4 (JARVIS-102): vakten som tvinger hver skrivehandling til å ta stilling til nøkkelkravet. Produksjonsregisteret (samme sammensetning som `part3-tool-manifest.test.ts`) får `idempotency` fra den deterministiske
 * listen (`idempotency-requirements.ts`); den utledede listen er festet i `fixtures/wpt1-idempotency-decisions.json`. En NY skrivehandling, en endret regel eller en endret definisjon endrer listen og feller testen
 * til fixturen er regenerert BEVISST (`UPDATE_IDEMPOTENCY_FIXTURE=1 pnpm exec vitest run apps/api/test/wpt1-idempotency-decisions.test.ts`) og diffen er forklart i PR-en (hver endring = en beslutning om at en handling skal/ikke skal kreve nøkkel).
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wpt1-idempotency-decisions.json");

function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}

interface Row { key: string; class: string; effect: string; external: boolean; mode: string; rule: string }
const defs = productionDefinitions();
const rowOf = (d: ToolDefinition): Row => ({
  key: `${d.tool_id}.${d.action}`, class: d.capability_class, effect: inferEffect(d.tool_id, d.action), external: !isJarvisCoreNamespace(d.tool_id), mode: String(d.idempotency), rule: decideIdempotency(d).rule
});
const rows = defs.map(rowOf).sort((a, b) => (a.key < b.key ? -1 : 1));
const isRead = (r: Row): boolean => r.class === "A" || r.effect === "read";
const writes = rows.filter((r) => !isRead(r));

describe("K4: produksjonsregisteret er merket fra den deterministiske nøkkelkrav-listen", () => {
  it("HVER produksjonsdefinisjon bærer en eksplisitt `idempotency` (ingen slipper forbi komposisjonsroten uten stilling)", () => {
    expect(defs.length).toBeGreaterThan(400);
    for (const d of defs) expect(["required", "optional", "none"], `${d.tool_id}.${d.action}`).toContain(d.idempotency);
  });

  it("listen over skrivehandlinger er festet: en ny/endret handling feller testen til fixturen er regenerert og forklart", () => {
    if (process.env["UPDATE_IDEMPOTENCY_FIXTURE"] === "1") writeFileSync(FIXTURE, `${JSON.stringify(writes, null, 1)}\n`, "utf8");
    expect(existsSync(FIXTURE), "fixturen mangler: kjør med UPDATE_IDEMPOTENCY_FIXTURE=1").toBe(true);
    const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Row[];
    const pinnedByKey = new Map(pinned.map((r) => [r.key, r]));
    const added = writes.filter((r) => !pinnedByKey.has(r.key)).map((r) => `${r.key} (${r.mode}, ${r.rule})`);
    const removed = pinned.filter((r) => !writes.some((w) => w.key === r.key)).map((r) => r.key);
    const changed = writes.filter((r) => pinnedByKey.has(r.key) && JSON.stringify(pinnedByKey.get(r.key)) !== JSON.stringify(r)).map((r) => `${r.key}: ${JSON.stringify(pinnedByKey.get(r.key))} -> ${JSON.stringify(r)}`);
    expect({ added, removed, changed }, "ta stilling til nøkkelkravet for hver ny/endret skrivehandling (se idempotency-requirements.ts), regenerer fixturen og forklar endringen").toEqual({ added: [], removed: [], changed: [] });
  });

  it("ren lesing er `none`; ingen klasse A-handling er noen gang `required`", () => {
    for (const r of rows.filter(isRead)) expect(["none", "optional"], r.key).toContain(r.mode); // `optional` kun for nødbrytere/selvgjenoppretting som også er lesinger
    for (const r of rows.filter((x) => x.class === "A")) expect(r.mode, r.key).not.toBe("required");
  });

  it("klasse D er `required`, UNNTATT nødbryterne/selvgjenopprettingen (må virke uten nøkkel: `optional`)", () => {
    for (const d of defs.filter((x) => x.capability_class === "D")) {
      const exempt = isClassDExempt(d) || isSelfRecoveryAction(d.tool_id, d.action);
      expect(d.idempotency, `${d.tool_id}.${d.action}`).toBe(exempt ? "optional" : "required");
    }
    for (const key of CLASS_D_EXEMPT_ACTIONS) {
      const d = defs.find((x) => `${x.tool_id}:${x.action}` === key);
      if (d) expect(d.idempotency, key).toBe("optional");
    }
  });

  it("håndhevingen er aldri svakere enn manifestets utledede krav: alt manifestet kaller `required` er `required` her (unntatt nødbryterne)", () => {
    const manifest = buildToolManifest(defs);
    for (const d of defs) {
      const entry = manifest.get(`${d.tool_id}.${d.action}`)!;
      const exempt = isClassDExempt(d) || isSelfRecoveryAction(d.tool_id, d.action);
      if (entry.idempotency === "required" && !exempt) expect(d.idempotency, entry.key).toBe("required");
    }
  });

  it("pengehandlinger, utsendelse, sletting og klasse D er alltid `required` (R2-R5)", () => {
    for (const r of writes) {
      if (["pay", "send", "delete"].includes(r.effect) || r.class === "D") {
        const exempt = r.rule === "R0_safety_switch";
        expect(r.mode, r.key).toBe(exempt ? "optional" : "required");
      }
    }
    const required = writes.filter((r) => r.mode === "required").map((r) => r.key);
    for (const key of ["email.send", "slack.notify", "telegram.notify", "twilio.notify", "finance.submit_payment_intent", "finance_wallester.submit_card", "drive.trash", "business.delete_lead", "calendar.create_event", "github.comment_on_issue", "support.reply", "openai_images.generate_image"]) {
      expect(required, key).toContain(key);
    }
  });

  it("Jarvis-eid intern tilstand og idempotente leverandørhandlinger er `optional` (R7), og hver beslutning har en regel", () => {
    for (const r of writes) {
      if (r.rule === "R7a_external_idempotent" || r.rule === "R7b_internal_state") expect(r.mode, r.key).toBe("optional");
      if (r.rule === "R6_external_not_idempotent") expect(r.mode, r.key).toBe("required");
    }
    expect(new Set(writes.map((r) => r.rule)).size).toBeGreaterThanOrEqual(6);
  });
});

describe("K1/K4: felt med hemmelighetsaktige navn er enten utelatt fra digesten eller erklært ikke-hemmelige", () => {
  it("hvert skjemafelt som ligner en hemmelighet står i DIGEST_EXCLUDED_PARAMETERS (og definisjonen bærer det) eller i SECRET_NAME_NOT_A_SECRET med begrunnelse", () => {
    const offenders: string[] = [];
    for (const d of defs) {
      const shape = (d.input_schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const field of Object.keys(shape)) {
        if (!SECRET_LIKE_PARAMETER_NAME.test(field)) continue;
        const key = `${d.tool_id}.${d.action}`;
        const excluded = (DIGEST_EXCLUDED_PARAMETERS[key] ?? []).includes(field) && (d.digest_exclude_parameters ?? []).includes(field);
        const declaredHarmless = SECRET_NAME_NOT_A_SECRET[`${key}.${field}`] !== undefined;
        if (!excluded && !declaredHarmless) offenders.push(`${key}.${field}`);
      }
    }
    expect(offenders, "et felt som ligner en hemmelighet må utelates fra request_digest (DIGEST_EXCLUDED_PARAMETERS) eller erklæres ikke-hemmelig").toEqual([]);
  });

  it("hver oppføring i listene peker på en registrert handling med det feltet (ingen døde unntak)", () => {
    for (const [key, fields] of Object.entries(DIGEST_EXCLUDED_PARAMETERS)) {
      const d = defs.find((x) => `${x.tool_id}.${x.action}` === key);
      expect(d, key).toBeDefined();
      const shape = (d!.input_schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const f of fields) expect(Object.keys(shape), `${key}.${f}`).toContain(f);
    }
    for (const full of Object.keys(SECRET_NAME_NOT_A_SECRET)) {
      const [tool, action, field] = [full.split(".")[0]!, full.split(".")[1]!, full.split(".")[2]!];
      const d = defs.find((x) => x.tool_id === tool && x.action === action);
      expect(d, full).toBeDefined();
      expect(Object.keys((d!.input_schema as unknown as { shape?: Record<string, unknown> }).shape ?? {}), full).toContain(field);
    }
  });
});
