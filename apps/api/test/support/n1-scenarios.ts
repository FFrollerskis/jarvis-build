import type { ErrorSpec, Row, Scenario } from "./n1-engine-harness.ts";

/**
 * WP-N1: scenariosettet for differensialtesten «flagg AV == main» (og gjenbrukt av flagg-PÅ-testene). 11 historikker x 6 spørsmål (kryssprodukt) + egne scenarier for hurtigbane, råd, ruteoverstyring, feilbaner,
 * minnevarianter og diverse = godt over 60 historier/fraser, hver kjørt på BEGGE flater (web og tale). Scenariosettet er KILDEN: legg nye scenarier til her og regenerer baseline-fixturen (se `wpn1-flag-off-differential.test.ts`).
 *
 * Noen historikker bærer `restricted: true` på nøytral tekst. Det er bevisst: det er merkene en tidligere periode med flagget PÅ kunne ha etterlatt. Med flagget AV skal de være HELT usynlige (main kjenner ikke feltet).
 */
const U = (content: string, restricted?: boolean): Row => ({ role: "user", content, ...(restricted === undefined ? {} : { restricted }) });
const A = (content: string, restricted?: boolean): Row => ({ role: "assistant", content, ...(restricted === undefined ? {} : { restricted }) });

export const HISTORIES: Record<string, Row[]> = {
  empty: [],
  clean: [U("hva heter hunden til naboen"), A("Det vet jeg ikke."), U("takk"), A("Bare hyggelig.")],
  fin_recent: [U("hva heter hunden til naboen"), A("Det vet jeg ikke."), U("Saldoen min er 45 000 kr"), A("Det er notert.")],
  fin_old: [U("Lønnen min kom i dag"), A("Fint."), U("hva er klokka"), A("Den er ti."), U("hva heter bilen til naboen"), A("Det vet jeg ikke."), U("hei"), A("Hei!")],
  fin_tail: [U("hvordan ligger vi an med den store greia"), A("Lånet ditt er på 2 mill."), U("takk for hjelpen i dag"), A("Bare hyggelig.")],
  health_recent: [U("hva heter hunden til naboen"), A("Det vet jeg ikke."), U("Det er kronisk, jeg tar Metformin"), A("Det er notert.")],
  secret_recent: [U("PIN-koden min er 4821"), A("Den er ikke lagret.")],
  restricted_neutral_recent: [U("hva heter hunden til naboen"), A("Det vet jeg ikke."), U("hva ble det av det", true), A("Det er 45 000 igjen.", true)],
  restricted_neutral_old: [U("hva ble det av det", true), A("Det er 45 000 igjen.", true), U("hva er klokka"), A("Den er ti."), U("hva heter hunden til naboen"), A("Det vet jeg ikke."), U("takk"), A("Bare hyggelig.")],
  business: [U("kontrakten er signert"), A("Flott, den er lagret.")],
  pr_then_clean: [U("list åpne PR-er på github"), A("Det er tre åpne PR-er."), U("takk"), A("ok")]
};

export const ASKS: Record<string, string> = {
  github: "list åpne PR-er på tsworkflow/jarvisbuild",
  email: "sjekk e-posten min",
  finance: "hva er saldoen min",
  memory: "hva husker du om hytta vår",
  plain: "hva synes du om været i dag",
  follow: "og den andre?"
};

const MEM_HEALTH = { text: "MINNEBLOKK helse - legetime", spaces: ["health"], sensitivities: ["normal"] };
const MEM_SPECIAL = { text: "MINNEBLOKK særlig - notat", spaces: ["personal"], sensitivities: ["special"] };
const MEM_PERSONAL = { text: "MINNEBLOKK personlig - hytta", spaces: ["personal"], sensitivities: ["normal"] };
const MEM_BUSINESS = { text: "MINNEBLOKK forretning - avtalen", spaces: ["business"], sensitivities: ["normal"] };
const PRIOR_PRS = HISTORIES["pr_then_clean"]!;

const timeout = (provider = "anthropic"): ErrorSpec => ({ kind: "provider", provider, errKind: "timeout" });

export const SCENARIOS: Scenario[] = [
  // 11 x 6 kryssprodukt
  ...Object.entries(HISTORIES).flatMap(([history, prior]) => Object.entries(ASKS).map(([ask, text]): Scenario => ({ id: `${history}.${ask}`, text, prior }))),

  // hurtigbanen (12 intensjoner + bakgrunnsjobber)
  ...[
    ["fast.status", "status"], ["fast.selfdiag", "hva er galt med deg"], ["fast.slo", "hvor bra yter du"], ["fast.evolution", "hvordan utvikler du deg"], ["fast.cost", "hva koster du"],
    ["fast.value", "hva har du hjulpet meg med"], ["fast.taskstatus", "jobbstatus task-7"], ["fast.create", "opprett jobb: skriv ukesrapport"], ["fast.cancel", "avbryt jobb task-7"],
    ["fast.help", "hjelp"], ["fast.light", "slå på lyset"]
  ].map(([id, text]): Scenario => ({ id: id as string, text: text as string, prior: HISTORIES["clean"]! })),
  { id: "fast.cost.after_fin", text: "hva koster du", prior: HISTORIES["fin_recent"]! },
  { id: "fast.value.after_restricted", text: "hva har du hjulpet meg med", prior: HISTORIES["restricted_neutral_recent"]! },
  { id: "fast.delegate.github", text: "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", prior: HISTORIES["clean"]! },
  { id: "fast.delegate.finance", text: "undersøk lånet mitt og saldoen min i bakgrunnen", prior: HISTORIES["clean"]! },
  { id: "fast.delegate.after_fin", text: "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", prior: HISTORIES["fin_recent"]! },
  { id: "fast.delegate.after_restricted", text: "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", prior: HISTORIES["restricted_neutral_recent"]! },
  { id: "fast.delegate.override", text: "list åpne PR-er i bakgrunnen, bruk kun lokale modeller", prior: HISTORIES["clean"]! },

  // rådet
  { id: "council.explicit", text: "bruk AI-rådet på dette: skal vi bytte leverandør", prior: HISTORIES["clean"]! },
  { id: "council.explicit.finance", text: "bruk AI-rådet: skal jeg ta opp et lån", prior: HISTORIES["clean"]! },
  { id: "council.explicit.after_restricted", text: "bruk AI-rådet på dette: skal vi bytte leverandør", prior: HISTORIES["restricted_neutral_recent"]! },
  { id: "council.auto.highimpact", text: "skal vi investere 3 000 000 kr i et nytt lager", prior: HISTORIES["clean"]! },
  { id: "council.suppressed", text: "ikke bruk AI-rådet: skal vi investere 3 000 000 kr i et nytt lager", prior: HISTORIES["clean"]! },
  { id: "council.unconfigured", text: "bruk AI-rådet på dette: skal vi bytte leverandør", prior: HISTORIES["clean"]!, council: false },
  { id: "council.unconfigured.finance", text: "bruk AI-rådet: skal jeg ta opp et lån", prior: HISTORIES["clean"]!, council: false },

  // ruteoverstyring og eksplisitt leverandør
  { id: "override.local_only", text: "list åpne PR-er på github, bruk kun lokale modeller", prior: HISTORIES["clean"]! },
  { id: "override.claude", text: "bruk Claude: hva synes du om været i dag", prior: HISTORIES["clean"]! },
  { id: "override.no_paid", text: "ikke bruk betalte modeller: list åpne PR-er på github", prior: HISTORIES["fin_recent"]! },
  { id: "override.provider_param", text: "list åpne PR-er på github", prior: HISTORIES["clean"]!, provider: "gemma_local" },

  // feilbaner (ikke strømming og strømming)
  { id: "error.budget", text: "hva synes du om været i dag", prior: HISTORIES["clean"]!, failures: [{ kind: "budget", level: "hard_blocked" }] },
  { id: "error.budget.restricted_prior", text: "hva synes du om været i dag", prior: HISTORIES["restricted_neutral_recent"]!, failures: [{ kind: "budget", level: "needs_approval" }] },
  { id: "error.budget.stream", text: "hva synes du om været i dag", prior: HISTORIES["clean"]!, streaming: true, failures: [{ kind: "budget", level: "hard_blocked" }] },
  { id: "error.cancelled.stream", text: "hva synes du om været i dag", prior: HISTORIES["clean"]!, streaming: true, failures: [{ kind: "provider", provider: "gemma_local", errKind: "cancelled", partial: "Været er" }] },
  { id: "error.interrupted.stream", text: "hva synes du om været i dag", prior: HISTORIES["clean"]!, streaming: true, failures: [{ kind: "provider", provider: "gemma_local", errKind: "stream_interrupted", partial: "Været er" }] },
  { id: "error.cloud_timeout.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, failures: [timeout()] },
  { id: "error.cloud_timeout.variant", text: ASKS["github"]!, prior: HISTORIES["fin_recent"]!, failures: [timeout()] },
  { id: "error.cloud_timeout.variant.restricted", text: ASKS["github"]!, prior: HISTORIES["restricted_neutral_recent"]!, failures: [timeout()] },
  { id: "error.cloud_auth", text: ASKS["github"]!, prior: HISTORIES["clean"]!, failures: [{ kind: "provider", provider: "anthropic", errKind: "auth" }] },
  { id: "error.local_bad_request.tools", text: ASKS["memory"]!, prior: HISTORIES["clean"]!, failures: [{ kind: "provider", provider: "gemma_local", errKind: "bad_request" }] },
  { id: "error.local_bad_request.finance", text: ASKS["finance"]!, prior: HISTORIES["clean"]!, failures: [{ kind: "provider", provider: "gemma_local", errKind: "bad_request" }] },
  { id: "error.preference_exhausted", text: ASKS["plain"]!, prior: HISTORIES["clean"]!, failures: [{ kind: "no_eligible", detail: "provider_preference_exhausted" }] },
  { id: "error.generic", text: ASKS["plain"]!, prior: HISTORIES["clean"]!, failures: [{ kind: "generic", message: "uventet" }] },
  { id: "error.two_failures", text: ASKS["github"]!, prior: HISTORIES["fin_recent"]!, failures: [timeout(), timeout("gemma_local")] },

  // dagstak og verktøyrute av
  { id: "daycap.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, dayCapReached: true },
  { id: "daycap.github.fin", text: ASKS["github"]!, prior: HISTORIES["fin_recent"]!, dayCapReached: true },
  { id: "route_off.github", text: ASKS["github"]!, prior: HISTORIES["fin_recent"]!, toolRoute: false },

  // minnevarianter
  { id: "memory.health_space.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, meta: MEM_HEALTH },
  { id: "memory.special.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, meta: MEM_SPECIAL },
  { id: "memory.personal.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, meta: MEM_PERSONAL },
  { id: "memory.business.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, meta: MEM_BUSINESS },
  { id: "memory.personal.after_restricted", text: ASKS["github"]!, prior: HISTORIES["restricted_neutral_recent"]!, meta: MEM_PERSONAL },

  // verktøykall midt i turen
  { id: "roundcalls.github", text: ASKS["github"]!, prior: HISTORIES["clean"]!, roundCalls: ["github__list_pull_requests"] },
  { id: "roundcalls.memory_local", text: ASKS["memory"]!, prior: HISTORIES["clean"]!, roundCalls: ["search_my_memory"] },

  // diverse
  { id: "misc.long_pasted", text: `Fra: a@example.no\nTil: b@example.no\nEmne: noe\n${"lang tekst ".repeat(160)}`, prior: HISTORIES["clean"]! },
  { id: "misc.same_as_previous", text: "hva heter hunden til naboen", prior: HISTORIES["clean"]! },
  { id: "misc.emoji", text: "hva synes du om været i dag 🌧️", prior: HISTORIES["clean"]! },
  { id: "misc.prior_note", text: ASKS["github"]!, prior: [U("list åpne PR-er på github"), A("Det er tre åpne PR-er.\n\n(Svart på den lokale modellen: meldingen eller de siste meldingene berører økonomi, og slikt sendes aldri til skyen.)")] },
  { id: "misc.prior_20_rows", text: ASKS["follow"]!, prior: [...HISTORIES["pr_then_clean"]!, ...HISTORIES["clean"]!, ...HISTORIES["clean"]!, ...HISTORIES["clean"]!, ...HISTORIES["clean"]!] },
  { id: "misc.followup_after_pr", text: ASKS["follow"]!, prior: PRIOR_PRS },
  { id: "misc.streaming_ok", text: "hva synes du om været i dag", prior: HISTORIES["clean"]!, streaming: true },
  { id: "misc.streaming_tools", text: ASKS["github"]!, prior: HISTORIES["fin_recent"]!, streaming: true }
];
