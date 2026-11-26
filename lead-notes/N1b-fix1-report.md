TS: 2026-11-26T00:33:32.611Z
**WP-N1b fiks-runde 1: ferdig, pushet, DORMANT og NOT VERIFIED mot NAS**

Ny tipp er **`616a8977`** på `claude/wp-n1b-finance-serving-model`, pushet (`git ls-remote` gir samme SHA). Treet er rent. Det er 13 commits siden `ebc85c38`; origin er `FFrollerskis/jarvis-build`.

**FIX-1..9** (rød-først betyr ny test mot produksjonskoden fra `ebc85c38`: 54 av 431 tester røde i 6 av 9 filer)

| FIX | Resultat | Kode / test |
|---|---|---|
| 1 MEDIUM | Done. Sikkerhet-senteret filtrerer frosne finanskoblinger, tilbakekalte finans-credentials og `spend`-pausen før listene og tellingene. Det gjelder bare med vakten på, via den prosesskonstante `financeGuard` (`main.ts` → `register.ts` → `security.ts`). | R24a/b i tabell og orakeltest; strukturtest H; F06-F11. Rød-først 16 tester. |
| 2 MEDIUM | Done. `executive.get_infra_status` gir bare merket, før kilden leses. `infra`-situasjonene holdes ute sammen med `spend`. | R25, R08b, R08c, R07; F12-F15. Rød-først 22 tester. |
| 3 | Done. `servingModel: null` regnes som sky; bare `undefined` betyr ingen modell. | `gateway.ts`; modell-skop G (17 former, nøstet og direkte). |
| 4 | Done. Setteren er ikke offentlig API, og alle forekomster av lesere og setter er pinnet per fil. | `index.ts`; F02, F03 (C41), F04 (C36). |
| 5 | Done. Vedlikeholdsloggen filtrerer finanskoblinger i SQL før `LIMIT`; `reason` er alltid `null`, og kostnadsrapporten leses ikke. | `RunRateService.maintenanceWithoutFinance`; R22; F16-F18. Rød-først 5 tester. |
| 6 | `telnyx.get_account_info` er done: saldoen holdes tilbake, og leverandøren kalles ikke for sky. De øvrige 9 vendorverktøyene er klassifisert som DEFERRED eller akseptert i `wpn1b-provider-tools.test.ts` og begrensning 26. | F31-F33. Rød-først 3 tester. |
| 7 | Done. Orakeltest (C15/C16), spiontester (C23/C24), hver arm for seg (A53/A55), `external_id` (A24), kopivakt for lokalitetsregelen (A80), alle 27 løkketyper. C20/C21 er bekreftet ekvivalente og testet. | `wpn1b-oracle`, `-withhold-before-read`, `-loop-types`. |
| 8 | Done. `audit_events.at` rettet i 7c og 7g. Tabellen er R01-R25 med 30 rader, og antallet er låst mot koden. SQL-snippene kjøres mot en migrert database. Begrensning 7 og I6 er rettet for K2. Tilbakehold telles ikke fra `audit_events`. K3-rekkefølgen har alle 8 center-flaggene. | `wpn1b-runbook.test.ts` (11). |
| 9 | Done. En løsrevet `execute` avvises i stedet for å kaste synkront. | Atferdstest; F05, F36. Rød-først 3 tester. |

**Tabellen:** 25 rader i koden mot «23» i teksten før, 30 nå. Nye er R08b, R08c, R24a, R24b og R25. Endret er R07, R08 og R22.

**Tester** (alle som `postgres`, `--maxWorkers=2`)
- N1b-filene: 10 filer / **442** tester grønne (var 5 / 218).
- `modules/tool-gateway/test` + N1-settet + `apps/api/test/wpn1*`: 171 / 2750. Bare de tre kjente F10a/b/c er røde.
- `modules/{conversation-graph,business,executive}/test`: 66 / 1221 grønne.
- Guards (`wph1-*`, `wph2-*`, `executive-parity`, `env-drift`, `d420`, `connector-sdk`): 40 / 882 grønne.
- Hele `apps/api/test` + `modules/situations/test`: 267 / **4315** grønne.

**Mutanter:** 75 totalt (39 gamle, 36 nye F01-F36). Full kjøring av de første 74 ga 72 drept av assertion, ingen tekniske brudd og ingen ugyldige. F36 (ny) og F05 er kjørt på nytt etter at atferdstesten kom til, og begge ble drept. F34 og F35 overlever og er merket ekvivalente (C20/C21).

| Reviewer-overlevende | Drept av |
|---|---|
| A71 | F17 |
| A24 | F26 |
| A53 / A55 | F27 / F28 |
| A80 | F30 |
| C15 / C16 | F24 / F25 |
| C23 / C24 | F13, F20-F23, F33 / F18, F19 |
| C36 / C41 | F04 / F03 |

**Flagg AV = main**
- Reviewer A sin `flagoff`-probe: 154 scenarier byte-like, mikrotask-tick identiske. Det ene kjente avviket (løsrevet `execute`) er borte.
- Øyeblikksbildet: 49 stier × 5 modeller = 245 observasjoner mot de 14 produksjonsfilene byttet inn fra `71a31d8b`. 17 rå forskjeller, alle målingens klokkeslett og `db_bytes`; etter normalisering av disse 0 forskjeller. Ingen svar bærer merket.
- Probene ligger utenfor repoet og er ikke committet. `wpn1-main-engine-baseline.json` er urørt.

**Statisk:** typecheck, lint og `check:containment` er exit 0 på siste kodeendring. `gitleaks` over `origin/main..HEAD` ga `no leaks found` på 22 commits; den siste commiten endret bare en mutantkommentar og er ikke skannet igjen.

**Forslag til D-482, antakelse 16-25** (full tekst i runbooken)
- 16: hele `infra`-domenet holdes tilbake for sky.
- 17: `get_infra_status` holdes tilbake helt.
- 18: Sikkerhet-senteret filtreres via `financeGuard`, ikke via `restrictFinance`.
- 19: `null` eller uleselig `servingModel` er sky.
- 20: setteren er ikke offentlig API.
- 21: vedlikeholdsloggen filtreres i SQL før `LIMIT`.
- 22: `telnyx.get_account_info` er finansavledet.
- 23: merket er alltid til stede, uten orakel.
- 24: aggregattellinger uten navn er akseptert.
- 25: workeren har ingen lås eller skop.

**Q-forslag**
- Q-N1b-1: AI-kost i øre og aggregattellinger (strengeste regel mot nytteverdi).
- Q-N1b-2: annonseutgift og `growth.*`.
- Q-N1b-3: skal Minne, Agent, Drift, Personvern og Sikkerhet holdes tilbake helt for sky?
- Q-N1b-4: lokalt svar som lagres umerket.
- Q-N1b-5: fjerne per-tjeneste-tilbakeholdet etter NAS-verifisering.
- Q-N1b-6: `get_churn_overview` og helse-situasjoner.
- Q-N1b-7: vakt i workeren.

**Åpent, ikke løst**
- **Workeren har ingen lås og intet skop.** `executive.get_capability_status` står på bakgrunnsflaten (`worker-main.ts:534-538`), og bakgrunnsjobber bruker skyrute (D-449). En bakgrunnsjobb på skymodell får derfor kapabilitetsstatusen uformet. Det er ikke en regresjon (som på main), men en reell åpen rest. Den er DEFERRED (Q-N1b-7), fordi flagget er api-only og et nytt flagg er utenfor scope; runbooken (I6, begrensning 7) sier det nå ærlig i stedet for «ikke et hull».
- Aggregattellinger (Drift-antall, kontrollhandlingstellinger), beløp i leverandørers egne felt (`twilio` `price`, CRM), `growth.*` og minnesøk er akseptert eller DEFERRED. Det står i begrensning 25-26 og 21.

**NOT VERIFIED:**
- Alt mot NAS (steg 7g-7q).
- Ekte modeller (Ollama/Anthropic).
- At skopet overlever alle ekte transporter (Gmail/Kalender, MCP, browser).
- De ekte hendelsesprodusentene i drift.
- Ekte Telnyx-, Twilio- og CRM-svar (leverandørfeltene er bare lest i koden).
- Workeren.

**Filer:**
- `/home/user/jarvisbuild/.claude/worktrees/n1b/docs/runbooks/WPN1_RESTRICTED_HISTORY.md`
- `/home/user/jarvisbuild/.claude/worktrees/n1b/apps/api/test/wpn1b-runbook.test.ts`
- `/home/user/jarvisbuild/.claude/worktrees/n1b/apps/api/test/support/wpn1b-mutants.mjs`
- `/home/user/jarvisbuild/.claude/worktrees/n1b/apps/api/src/control-center/security.ts`
