# ADR-001 – Dokumenthierarki for remedieringen

| Felt | Verdi |
|---|---|
| Dato | 2026-10-01 |
| Status | **PROPOSED** – blir gjeldende (interim) når PR-en som inneholder denne filen merges. Ingen del av dette er godkjent av en uavhengig reviewer ennå. |
| Fase | Remediering del 1 av 10 (`remediation/01-containment-baseline`) |
| Funn | JARVIS-058 (styring), JARVIS-059 (påstander vs. kode), JARVIS-100 (dokumentdrift); kryssversjonskonflikter X-01…X-05, X-09, X-21 i auditen |
| Beslutningslogg | D-363 i [DECISIONS_AND_ASSUMPTIONS.md](../DECISIONS_AND_ASSUMPTIONS.md) |
| Åpent spørsmål | Q-43 i [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md) (`MISSING_GOVERNING_INPUT`: HF6 / Continuous Intelligence v1.2) |

## 1. Kontekst

Auditen (`FINAL_AUDIT_REPORT*.md`, HEAD `35075a2`) fant at det ikke finnes noe formelt besluttet svar på «hvilket dokument gjelder»:

* `CLAUDE.md` og `CANONICAL_SPEC.md` rangerer CANONICAL_SPEC øverst, men CANONICAL_SPEC er selv «Utkast v1.0 – venter på Tobias sin godkjenning».
* Masterplan **v4.0** (Sovereign Autonomy) er de facto det alt UA-arbeid siterer, men er **aldri adoptert** ved en D-beslutning og er ikke nevnt i hierarkiet i `CLAUDE.md`. Overskriften i v4.0-filen er en konverteringsmerknad, ikke Tobias-tekst.
* `CLAUDE.md` sier fortsatt «Fase 0 – ingen applikasjonskode godkjent» og har regel 2/8 (signert godkjenning, ingen destruktive handlinger uten bekreftelse) side om side med regel 11 (eier-suverenitet, A–D styrer *hvordan*, ikke *om*).
* Implisitt adopsjon (D-37, D-41, D-64, D-120, D-169/D-170) har overstyrt eldre klausuler (D-06, D-08, D-09, CANONICAL §1.1/§1.2) **uten** at noen D-beslutning navngir hva som erstattes.

Konsekvensen er at en agent eller person som følger `CLAUDE.md` bokstavelig får det motsatte av hva kodebasen gjør. Remedieringen trenger derfor ett eksplisitt, midlertidig hierarki som ikke svekker noe stilltiende.

## 2. Beslutning

### 2.1 Grunnregel: strengeste sikkerhetsregel vinner til en eksplisitt beslutning erstatter den

Ved motstrid mellom to dokumenter gjelder den regelen som **begrenser autoritet og eksponering mest**, helt til en daterte D-beslutning fra Tobias **navngir** regelen (D-ID, CLAUDE.md-regelnummer eller dokument + paragraf) den erstatter. Implisitt adopsjon, statusord og kodepraksis erstatter ingenting.

Gamle sikkerhetsinvarianter **bevares** inntil slik beslutning finnes. Det gjelder blant annet: signert godkjenning for klasse D (D-06, CANONICAL §1.1.10, SECURITY_MODEL §3), ingen destruktive handlinger uten eksplisitt bekreftelse (CLAUDE.md regel 8), menneskelig produksjons-merge-gate (D-08), kostgrenser 1 000 / 2 000 / 3 000 kr (D-09, D-187), ubetrodd innhold er data og aldri instruksjon (regel 7), ingen secrets i kode/logger (regel 1).

Regel 11 (D-41) beholdes uendret **for eier-initierte handlinger via eierflater** (dashbord, kommandosentral): A–D styrer hvordan en handling utføres, ikke om eieren har kapabiliteten. Den gir **ikke** språkmodellen autoritet. Modell-initiert autoritet er i denne fasen avgrenset av §2.3.

### 2.2 Hierarki (høyest først)

| # | Dokument | Rolle i remedieringen | Versjon / dato | Forgjenger → erstatter |
|---|---|---|---|---|
| 1 | **Eksplisitte D-beslutninger** i `docs/DECISIONS_AND_ASSUMPTIONS.md` (D-01…D-362 + D-363) | Bindende. Nyeste gjelder – men en D-beslutning svekker bare en sikkerhetsinvariant hvis den navngir den (§2.1). | løpende | – |
| 2 | **`CLAUDE.md`** «Ufravikelige regler» 1–12 og samarbeids-/GitHub-protokollen | Bindende for agenten. Innbyrdes spenning regel 2/8 ↔ 11 er løst i §2.1/§2.3. «Fase 0»-linjen er **utdatert** og overstyres av denne ADR-en og `PROJECT_STATUS.md`. | ingen versjon | – |
| 3 | `docs/CANONICAL_SPEC.md` | Sikkerhets- og arkitekturkrav (utkast, aldri godkjent). Brukes som *strengeste-regel*-kilde. | «Utkast v1.0» | utledet fra Masterplan v2.1; delvis overstyrt de facto av v4.0 – ingen formell erstatning |
| 3 | `ARCHITECTURE`, `SECURITY_MODEL`, `MEMORY_ARCHITECTURE`, `VOICE_ARCHITECTURE`, `DEPLOYMENT_STRATEGY`, `INTEGRATIONS` | Samme som CANONICAL_SPEC. | «Utkast v1.0» (+ tillegg) | utledet fra v2.1 |
| 4 | `docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` | **Retning og UA-rekkefølge** (roadmap). Status: `ACKNOWLEDGED_NOT_ADOPTED`. Ingen v4.0-klausul svekker en invariant i §2.1 før en D-beslutning sier det. | v4.0, 2026-08-13 | bygger på v2.1; ikke formelt adoptert |
| 5 | `docs/input/01_Jarvis_Masterplan_v2.1.md` | Historisk kildedokument. | v2.1, 2026-08-12 | forgjenger for CANONICAL_SPEC og v4.0 |
| 6 | `IMPLEMENTATION_PLAN`, `RUNTIME_GATES`, `SOVEREIGN_GRADUATION_MATRIX`, `PROJECT_STATUS`, `OPEN_QUESTIONS` | **Statusdokumenter, ikke krav.** Ingen status kan overstyre et krav i nivå 1–5. | løpende | – |
| 7 | `FINAL_AUDIT_REPORT.md` / `_FULL.md` (HEAD `35075a2`) og `docs/remediation/*` | **Funn- og sporingsinput.** Funn er påstander som re-verifiseres mot gjeldende HEAD (se `FINDINGS_LEDGER.md`), ikke krav. | 2026-10-01 | den forrige auditen 2026-09-23 ble aldri triagert (0/3 P0 lukket) |

Eldre audit: `docs/audit/2026-09-23-full-project-audit/` – historisk, ikke triagert.

### 2.3 Interimsregler som gjelder fra denne PR-en (avgrenser bare – åpner ingenting)

1. **Modell-initiert autoritet** (chat, tale, Telegram, executive-jobber) er et **eksplisitt, lesende minimumssett** (`MODEL_SURFACE_ALLOWLIST`, klasse A). Ingen skriv/slett/send/betal/merge/eierkontroll-verktøy. Utvidelse krever en ny D-beslutning *og* at `assertReadOnlyModelSurface()` består.
2. **Ingen autonom selvmodifikasjon** og ingen issue-#68/PC-worker-løkke før remedieringsdel 9.
3. **Ingen vilkårlig kommandokjøring** via executive-jobber.
4. **Kostgrensen (3 000 kr/mnd) beholdes.** Fantomforbruk fjernes ved å prise modellene riktig, ikke ved å heve grensen.
5. **Merge-protokollen** (D-120/D-150/D-192 i `CLAUDE.md`) gjelder uendret for builder-agenten. Denne PR-en merges ikke av Claude.
6. **Statusord:** «VERIFIED», «LIVE-PROVEN» og «PRODUCTION_VERIFIED» krever et artefakt som finnes i repoet eller i en lenket CI-/host-kjøring på *gjeldende* kode. Ellers brukes ordforrådet i §2.4.

### 2.4 Felles statusordforråd (brukes i `FINDINGS_LEDGER.md` og statusdokumenter)

| Status | Betydning |
|---|---|
| `OPEN` | Funnet er re-verifisert som åpent, ingenting gjort. |
| `CONTAINED` | Den aktive faren er stengt i repoet (flate fjernet/frosset/bundet), men rotårsaken er ikke fikset. |
| `CODE_FIXED` | Kode + test finnes og består i CI, men er **ikke deployet** og **ikke runtime-verifisert**. |
| `DEPLOYED_UNVERIFIED` | Deployet, men uten runtime-bevis. |
| `VERIFIED` | Runtime-bevis (kommando-output / host-kjøring) på gjeldende kode finnes og er lenket. |
| `BLOCKED_EXTERNAL` | Krever host-/fysisk handling, repo-innstilling, credential, betaling eller juridisk aksept som Tobias må gjøre. |
| `MISSING_GOVERNING_INPUT` | Et styrende dokument som refereres finnes ikke i repoet. Ingen krav er hentet fra det. |
| `DEFERRED` | Bevisst utsatt til en navngitt senere fase. |

## 3. Manglende styrende input: `MISSING_GOVERNING_INPUT`

**HF6 / «Continuous Intelligence v1.2» finnes ikke i repoet.** Søk gjort 2026-10-01 på HEAD:

* alle sporede filer (`git ls-files`) – ingen filnavn med `hf6` eller `continuous`;
* filnavn i alle `refs/remotes/origin/*` – kun `docs/input/01_…v2.1.md` og `02_…v4.0.md`;
* tekstsøk (inkl. filer som `grep` flagger som binære) i `docs/*.md`, `docs/*/*.md` og `CLAUDE.md` – ingen treff på «HF6» eller «Continuous Intelligence».

Konsekvenser:

* **Ingen krav er hentet fra HF6.** Ingenting i remedieringen påstår å følge den.
* Sikkerhetsarbeidet fortsetter (del 1 er ikke avhengig av den).
* Når filen leveres, skrives et **addendum** til denne ADR-en som registrerer versjon, forgjenger og hva den erstatter, og først deretter flyttes den inn i hierarkiet. Frem til da gjelder §2.1 (strengeste regel vinner).
* Tobias bes bekrefte om filen finnes, hvor, og hvilken versjon (Q-43).

## 4. Konflikter denne ADR-en håndterer midlertidig (ikke endelig løst)

| ID (audit) | Konflikt | Interim-håndtering |
|---|---|---|
| X-01 | Signert godkjenning klasse D (v2.1/CANONICAL/D-06) ↔ autonom D for eier (v4.0/regel 11) | Eier-flater: regel 11 (uendret). Modell-flater: ingen klasse B–D (§2.3 pkt 1). Endelig UX for klasse-D-bekreftelse hører til senere del. |
| X-02 | Utgående/destruktive handlinger uten bekreftelse | Ingen slike handlinger er modell-kallbare (§2.3 pkt 1). |
| X-03 | Kostgrenser | Beholdt (§2.3 pkt 4). |
| X-04 | Menneskelig merge-gate | D-120/D-150/D-192 for builder; ingen produkt-merge (selvmodifikasjon frosset). |
| X-05 | Autonom selvreparasjon/-modifikasjon | Frosset (§2.3 pkt 2). |
| X-09, X-21 | Leverandør uten benchmark; «Bygges IKKE»-lister | Ikke endret her; faseporten (regel 10) kan ikke anvendes mekanisk – avklares av Tobias/arkitekt. |

Øvrige X-rader (X-06…X-33) er **uendret og uløst** og følges i ledgeren under JARVIS-058/059/100.

## 5. Hva denne ADR-en IKKE gjør

* Den adopterer **ikke** v4.0 og oppdaterer **ikke** CANONICAL_SPEC.md (utkastet beholder sin overskrift).
* Den fjerner **ingen** eldre beslutning. Hver svekkelse krever en egen, navngitt D-beslutning fra Tobias.
* Den lukker **ikke** JARVIS-058/059/100 – den er første steg (`CODE_FIXED` i dokumentform, ikke `VERIFIED`).

## 6. Oppfølging

* `CLAUDE.md` får en kort henvisning til denne ADR-en (den utdaterte «Fase 0»-linjen slettes ikke – den merkes).
* Branch protection / påkrevd review på `main` hører til del 1 punkt 9 og er `BLOCKED_EXTERNAL` (se `PHASE_1_GATE.md`).
* Neste ADR (senere del): endelig godkjenningsmodell for klasse C/D (taint-gate, per-flate verktøysett, bekreftelse) – erstatter §2.3 pkt 1.
