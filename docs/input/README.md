# docs/input: kildedokumenter (masterplanene)

Statusdokument (ADR-001 nivå 4/5/6), ikke et krav. Mappen holder planene eieren har levert. **PDF-en er alltid originalkilden;** `.md`-filene er automatiske tekstuttrekk (`pdftotext -layout`) for søk og lesing, og kan ha brutte tabeller og sidetall.

| Fil (`.md`) | Plan | Versjon / dato | Programkode og faser | Originalkilde (`docs/input/pdf/`) |
|---|---|---|---|---|
| `01_Jarvis_Masterplan_v2.1.md` | Autoritativ masterplan v2.1 | v2.1, 2026-08-12 | den ti-delte byggeplanen (historisk kildedokument) | (ingen PDF i repoet) |
| `02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` | **HF1** Sovereign Autonomy | v4.0, 2026-08-13 | Fase 0-10 (kap. 6), UA-0 … UA-11 (kap. 8), Value Track V1-V5 (kap. 9), Definition of Done (kap. 28) | `HF1_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.pdf` (31 s) |
| `03_HF2_Jarvis_Evolution_Masterplan_v1.2_FINAL_GOVERNING_EDITION.md` | **HF2** Evolution | v1.2 FINAL GOVERNING EDITION, 2026-08-13 | EV-0 … EV-23 | `HF2_Jarvis_Evolution_Masterplan_v1.2_FINAL_GOVERNING_EDITION.pdf` (20 s) |
| `04_HF3_Jarvis_Multi_Company_Identity_Trust_Platform_Operations_Masterplan_v1.3_FINAL.md` | **HF3** Multi-Company Identity, Trust & Platform Operations | v1.3 FINAL, 2026-08-13 | MC-0 … MC-13 | `HF3_Jarvis_Multi_Company_Identity_Trust_Platform_Operations_Masterplan_v1.3_FINAL.pdf` (19 s) |
| `05_HF4_Jarvis_Empire_Expertise_Masterplan_v1.2_FINAL.md` | **HF4** Empire + Expertise | v1.2 FINAL, 2026-08-13 | EX-0 … EX-8 og MC-E1 … MC-E3 (Empire) | `HF4_Jarvis_Empire_Expertise_Masterplan_v1.2_FINAL.pdf` (26 s) |
| `06_HF5_Jarvis_Masterplan_Adaptive_Continuity_v1.1.md` | **HF5** Adaptiv Kontinuitet | v1.1, 2026-08-16 | JX-0 … JX-8 | `HF5_Jarvis_Masterplan_Adaptive_Continuity_v1.1.pdf` (19 s) |
| `07_HF6_Continuous_Intelligence_v1.2_FINAL_GOVERNING_EDITION.md` | **HF6** Continuous Intelligence (capstone) | v1.2 FINAL GOVERNING EDITION, 2026-09-25 | CI-0 … CI-11; **§24 = programkonstitusjon** (D-PROG-01…11) | `HF6_Continuous_Intelligence_v1.2_FINAL_GOVERNING_EDITION.pdf` (25 s) |

**Konvertering:** `02_…` er en eldre, redigert konvertering av HF1-PDF-en (ca. 90 % tekstoverlapp; PDF-en gjelder ved tvil). `03_…`-`07_…` er uredigerte `pdftotext -layout`-uttrekk, én fenced blokk per side, sidemarkør `<!-- side N -->`. HF2-PDF-en og HF6-filen manglet i repoet til 2026-11-26 (`MISSING_GOVERNING_INPUT`, Q-43); eieren leverte alle seks planene som PDF 2026-11-26.

## Status ved ADR-001 (ingen plan er formelt adoptert som styrende)

- **HF1 (v4.0):** `ACKNOWLEDGED_NOT_ADOPTED` (ADR-001 §2.2 nivå 4). Retning og UA-rekkefølge; ingen v4.0-klausul svekker en invariant i ADR-001 §2.1 før en navngitt D-beslutning sier det.
- **HF2-HF6:** HF2-HF5 nevnes ikke i ADR-001 (skrevet før de lå i repoet), og HF6 er nevnt som `MISSING_GOVERNING_INPUT` (ADR-001 §3, Q-43). De har derfor ingen formell status utover «mottatt som input 2026-11-26» og behandles som HF1: retning og byggeunderlag, aldri et krav som svekker en ufravikelig regel (CLAUDE.md regel 1-12). ADR-001 §3 krever et addendum (versjon, forgjenger, hva den erstatter) før HF6 flyttes inn i hierarkiet; det er ikke skrevet (Q-86). Eieren har bestilt at alt i HF1-HF6 bygges (D-496); det er en byggeordre, ikke en adopsjon.
- **HF6 §24** erklærer HF1-HF6 som «det governing plan-settet» (D-PROG-11) med en konfliktrekkefølge (§24.2: lov/plattform/kontrakt, så mest spesifikke domeneeier, HF3/Authority, HF2, HF1, HF4-HF6 kun i egne domener, ellers `PROGRAM_CONFLICT` uten stille vinner), en maskinlesbar `CANONICAL_SPEC` (§24.3) og 17 Program Completion-porter («NO EVIDENCE, NO FINISHED»). **Adopsjon som styrende plansett, og enhver erstatning av en ADR-001-/CLAUDE.md-regel, krever en navngitt D-beslutning fra eieren** (ADR-001 §2.1); inntil da gjelder strengeste sikkerhetsregel uendret, og et `PROGRAM_CONFLICT` bygges med trygg standard og logges (D-497 pkt 5).
- **D-406** (eier 2026-10-05): de seks planene bygges én og én som skrevet, uten sammenslåing eller kutting.

Status per plan (hva er bygget): [CLOSURE_MATRIX_HF1_HF2.md](../CLOSURE_MATRIX_HF1_HF2.md) (HF1 og HF2; matrisen ble bygget uten HF2-PDF og er ikke sjekket mot den) og [PROJECT_STATUS.md](../PROJECT_STATUS.md). HF3-HF6 har ingen matrise ennå; gap-analysene mot kjedetoppen pågår (2026-11-26) og er ikke ført inn i repoet. Beslutninger: D-496 (bygg alt i HF1-HF6), D-497 (stående fullmakt), åpent: Q-86.
