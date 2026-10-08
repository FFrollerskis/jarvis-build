import { afterAll, describe, expect, it, vi } from "vitest";
import { fastRoute } from "@jarvis/core";
import { parseRoutingOverride, type CompleteInput } from "@jarvis/model-gateway";
import type { IdentityContext } from "@jarvis/contracts";
import { baseIdentity, buildEngine, type MemItem, type Row } from "./support/fast-path-harness.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 4): DIFFERENSIALTEST. Gjennomgang 4 lot en uavhengig agent kjøre 233 100 hurtigbane-vurderinger mot chatten og fant 669 tilfeller der hurtigbanen var løsere; alle falt i tre
 * klasser (frasen midt i en ruteinstruksjon, linjeskift som endrer verktøyutvalget, en leveringsmelding som forskyver vinduet). Dette er et utsnitt av samme rutenett, nå fast i repoet, over produksjonens
 * verktøyoverflate: for HVER kombinasjon av melding × samtalehistorikk × minne × flate × plassering av «i bakgrunnen» gjelder
 *
 *     hurtigbanen får bruke skyen  ⇒  den samme forespørselen som vanlig chat (uten frasen) ville gått til skyen.
 *
 * Det motsatte (hurtigbanen strengere enn chatten) er tillatt og telles bare. Orakelet er det chatten faktisk sendte til modellgatewayen: låst sensitivitet, eierens ruteinstruksjon («kun lokale modeller»),
 * og `paid_models_allowed: false`. Rutenettet er også en vakt mot at en fremtidig endring av `resolveTurnRouting`, verktøyutvalget eller klassifiseringen åpner et hull for hurtigbanen alene.
 */
const BASES: string[] = [
  "list åpne PR-er på tsworkflow/jarvisbuild",
  "sjekk e-posten min og oppsummer",
  "hva står i kalenderen min neste uke",
  "finn alle e-postene fra banken forrige måned og oppsummer dem",
  "gå gjennom utgiftene og abonnementene mine i e-posten",
  "sjekk kontoutskriften fra DNB i e-posten min",
  "hva vet du om hytta vår",
  "og den neste da?",
  "og hva med den andre",
  "oppsummer det vi snakket om",
  "sjekk legetimen min i kalenderen",
  "finn e-post om lønn",
  "les e-post fra Vipps",
  "sjekk stripe-utbetalinger",
  "se på kortbruken min",
  "sjekk notion-notatene mine",
  "lag en rapport om GitHub-sakene",
  "hva er status på integrasjonene",
  "kun lokale modeller: list PR-er",
  "ikke bruk betalte modeller, men list PR-er",
  "bruk Claude og list PR-er",
  "bruk Gemma og list PR-er",
  "sjekk e-posten min, og bruk bare lokale modeller",
  "sjekk e-posten min, men ikke bruk betalte modeller",
  "velg den beste modellen og list PR-er",
  "ikke bruk AI-rådet, list PR-er",
  "finn e-post om diagnosen min",
  "finn kontrakten med kunden i e-posten",
  "hvor lang tid tar det\ndit",
  "sjekk  e-post fra  banken",
  "hei hei hei",
  "takk",
  "hva synes du om været",
  "kontoen",
  "sjekk transaksjonene",
  "finn kvitteringer for innkjøp",
  "les meldinger i slack-kanalen",
  "sjekk jira-sakene og github og kalender og e-post og notion og slack og trello og linear og hubspot og bank",
  "hvor lang tid\ntar det å kjøre dit",
  "sjekk kortet\npå boardet",
  "hvem er Ola\npå e-post",
  "sjekk e-post fra banken",
  "sjekk\tutgiftene",
  "kontonummer 1234\n56\n78901 sjekk e-post",
  "og den første?",
  "hva med i går",
  "fortell mer om det",
  "kan du se på det igjen"
];

const FINANCE: Row = { role: "user", content: "Saldoen min er 45 000 kr og lånet er på 2 mill" };
const asst = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ role: "assistant" as const, content: `greit ${i}` }));
const PRIORS: Record<string, Row[]> = {
  none: [],
  smalltalk: [{ role: "user", content: "hei" }, { role: "assistant", content: "Hei!" }],
  finance_user: [FINANCE],
  health_user: [{ role: "user", content: "Jeg hadde legetime i dag og fikk en ny diagnose" }],
  finance_assistant: [{ role: "user", content: "hva skjer" }, { role: "assistant", content: "Saldoen din er lav, og gjelden er høy." }],
  bank_carry_old: [{ role: "user", content: "vis bank-transaksjonene mine" }, ...asst(4)],
  bank_carry_pos3: [
    { role: "user", content: "vis bank-transaksjonene mine" }, { role: "assistant", content: "ok" },
    { role: "user", content: "fint" }, { role: "assistant", content: "ok" },
    { role: "user", content: "flott" }, { role: "assistant", content: "ok" }
  ],
  vipps_carry: [{ role: "user", content: "hva har jeg fått på vipps" }, ...asst(4)],
  delivered_gjeld: [{ role: "assistant", content: "Bakgrunnsjobben «PR-er» er ferdig: grenen claude/q49-gjeld-bic er åpen" }],
  pasted_prior: [{ role: "user", content: "Fra: a@b.no\nEmne: lønn\n\nhei" }]
};

const MEMS: Record<string, MemItem[] | null> = {
  nomemdep: null,
  empty: [],
  special_hytta: [{ terms: ["hytta"], space: "personal", sensitivity: "special" }],
  health_pr: [{ terms: ["pr-er", "github"], space: "health", sensitivity: "normal" }]
};

/** Plasseringer av delegeringsfrasen: slutt, prefiks, midt, versaler, spørsmål, linjeskift, ledende mellomrom, før siste ord, komma, punktum, tab. */
const PLACEMENTS: Record<string, (b: string) => string> = {
  suffix: (b) => `${b} i bakgrunnen`,
  prefix_bg: (b) => `Bakgrunnsjobb: ${b}`,
  prefix_del: (b) => `deleger: ${b}`,
  middle: (b) => { const i = b.indexOf(" "); return i < 0 ? `${b} i bakgrunnen` : `${b.slice(0, i)} i bakgrunnen${b.slice(i)}`; },
  upper: (b) => `${b} I BAKGRUNNEN`,
  question: (b) => `${b} i bakgrunnen?`,
  newline: (b) => `${b}\ni bakgrunnen`,
  lead_ws: (b) => `   ${b} i bakgrunnen   `,
  before_last: (b) => { const i = b.lastIndexOf(" "); return i < 0 ? `${b} i bakgrunnen` : `${b.slice(0, i)} i bakgrunnen${b.slice(i)}`; },
  prefix_ib: (b) => `I bakgrunnen, ${b}`,
  period: (b) => `${b} i bakgrunnen.`,
  tab: (b) => `${b}\ti bakgrunnen`
};

const CHANNELS = ["web", "voice", "telegram"] as const;

/** Hvorfor chatten holdt denne forespørselen lokal (eller null = chatten gikk til skyen). Basert på det chatten faktisk sendte til modellgatewayen. */
function chatLocalReason(base: string, input: CompleteInput | undefined): string | null {
  if (!input) return null;
  if (input.sensitivity === "SECRET_RESTRICTED") return "sensitivity";
  const override = parseRoutingOverride(base);
  if (override && (override.mode === "LOCAL" || (override.providerPreference !== undefined && override.providerPreference.every((p) => p.startsWith("gemma"))))) return "override_local";
  if (input.paid_models_allowed === false) return "paid_false";
  return null;
}

const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => { logSpy.mockRestore(); errSpy.mockRestore(); });

describe("D-449: differensialtest - hurtigbanen er aldri løsere enn chatten", () => {
  it("for hele rutenettet (melding × historikk × minne × flate × frase-plassering) gjelder: hurtigbane-sky ⇒ chat-sky", async () => {
    const violations: string[] = [];
    let evaluated = 0;
    let fastCloud = 0;
    let fastLocalWhileChatCloud = 0;
    let chatCloudCases = 0;
    for (const channel of CHANNELS) {
      const identity: IdentityContext = { ...baseIdentity, channel };
      for (const base of BASES) {
        if (fastRoute(base)) continue; // selve basen er en hurtigkommando
        for (const [priorName, prior] of Object.entries(PRIORS)) {
          for (const [memName, mem] of Object.entries(MEMS)) {
            const chat = buildEngine({ prior, mem });
            await chat.engine.handle(identity, base);
            const chatInput = chat.captured[0];
            const reason = chatLocalReason(base, chatInput);
            if (chatInput && reason === null) chatCloudCases += 1;
            for (const [placeName, place] of Object.entries(PLACEMENTS)) {
              const message = place(base);
              const intent = fastRoute(message);
              if (!intent || intent.kind !== "delegate_background") continue;
              const fast = buildEngine({ prior, mem });
              await fast.engine.handle(identity, message);
              if (fast.runs.length !== 1) continue;
              evaluated += 1;
              // Alt her løses via mikrooppgaver; uten en makrooppgave-pause får vitest-arbeideren aldri sendt fremdriftsmeldinger og feiler med «Timeout calling onTaskUpdate» på en tregere maskin.
              if (evaluated % 250 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
              const cloud = fast.runs[0]!.cloud;
              if (cloud) fastCloud += 1;
              if (cloud && reason !== null) {
                violations.push(`${channel} | ${JSON.stringify(base)} | historikk=${priorName} | minne=${memName} | plassering=${placeName} → hurtigbane=sky, chat=lokalt(${reason})`);
              }
              if (!cloud && chatInput && reason === null) fastLocalWhileChatCloud += 1;
            }
          }
        }
      }
    }
    process.stderr.write(`d449-differential: vurderinger=${evaluated} hurtigbane-sky=${fastCloud} chat-sky-tilfeller=${chatCloudCases} hurtigbane-strengere-enn-chat=${fastLocalWhileChatCloud} brudd=${violations.length}\n`);
    // Vakten må faktisk ha vurdert noe, og begge utfall må forekomme (ellers sier «ingen brudd» ingenting).
    expect(evaluated).toBeGreaterThan(20_000);
    expect(fastCloud).toBeGreaterThan(500);
    expect(chatCloudCases).toBeGreaterThan(500);
    // Hurtigbanen kan være strengere enn chatten (egen transportkontroll av jobbteksten, frasevarianter), men skal ikke være det i det store flertallet av skytilfellene.
    expect(fastLocalWhileChatCloud).toBeLessThan(evaluated);
    expect(violations.slice(0, 25), `${violations.length} brudd:\n${violations.slice(0, 25).join("\n")}`).toEqual([]);
  }, 600_000);
});
