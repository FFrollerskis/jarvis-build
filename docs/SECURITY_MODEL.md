# Jarvis – sikkerhetsmodell

**Status:** Utkast v1.0. Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md).
Sikkerhet er «Del 0»: fundamentet bygges før Jarvis kobles til e-post, web, GitHub, privat minne eller
eksterne handlinger.

## 1. Trusselmodell (oppsummert)

| Trussel | Primærforsvar |
|---|---|
| Prompt injection fra e-post/web/dokumenter | Tillitszoner + karantene + skjema-/policykontroll mellom soner |
| Eksfiltrering av secrets via LLM | Secret Zone: LLM leser aldri secrets; kortlivede tokens; nettverksallowlist |
| Uautoriserte kritiske handlinger | Capability-klasser + signerte godkjenningsobjekter verifisert i kode |
| Kryss-tenant-/kryss-space-lekkasje | RLS i databasen + eksplisitt space-autorisasjon i Context Builder + eval-tester |
| Løpsk agent (løkker, kostnad, skade) | Jobbkontrakt med maks steg/budsjett, automatisk stopp, kill switch |
| Kompromittert worker | Kastbar container per jobb, minimale tokens, nettverksallowlist, merge-gate |
| Tap av data | Kryptert backup, RTO/RPO-tiers, testet restore |
| Fysisk/lokal angriper (rom-satellitt) | Fysisk mute, lokal wake-word, ingen rå-lyd-lagring, enhetsidentitet |

## 2. Tillitszoner

```
Ingestion ──sanitert/strukturert──▶ Reasoning ──forslag──▶ Execution ──▶ verden
   │  ubetrodd innhold                  │ autorisert lesing      ▲
   ▼                                    ▼                        │ policy + godkjenning
 karantene                        Memory Zone             Secret Zone (vault)
```

- **Ingestion Zone:** e-post, nettsider, dokumenter, GitHub-issues, MCP-output. Alt er ubetrodd.
- **Reasoning Zone:** planlegging på sanitert/strukturert innhold.
- **Memory Zone:** autoritativt minne med proveniens; karantene for ukontrollert innhold.
- **Execution Zone:** deterministisk Policy Gateway og tillatte verktøy.
- **Secret Zone:** vault og kortlivede credentials som LLM-en aldri leser direkte.

**Kjerneinvariant:** En sesjon som analyserer ubetrodd innhold har aldri samtidig (a) fri lesing av privat
minne og (b) utgående handlinger. Overganger mellom soner krever skjema- og policykontroll.
Invarianteten håndheves av kode (sesjonsmodus i Policy Gateway), ikke av promptregler.

## 3. Capability-klasser og godkjenning

| Klasse | Beskrivelse | Krav |
|---|---|---|
| A | Lesing og ufarlig analyse | Space-/tenant-autorisasjon |
| B | Reversible interne handlinger | Auth_strength over terskel; logges |
| C | Eksterne handlinger innen uttrykkelig mandat | Forhåndsdefinert mandat (scope, mål, beløpsgrense); logges |
| D | Betaling, kontrakt, sletting, publisering, lås, alarm, tilgangsendring | **Signert godkjenningsobjekt** |

Godkjenningsobjekt (klasse D): `{handling, parametere, utløpstid, engangs-ID, godkjennende enhet,
signatur}`. Signeres av en godkjent enhet (Watch/telefon med enhetsnøkkel), verifiseres kryptografisk i
Policy Gateway, forbrukes én gang. LLM-en kan **be om** godkjenning, men kan ikke opprette, endre eller
omgå den. Parameterne i godkjenningen må matche verktøykallet eksakt – en godkjenning for «lås opp
ytterdør» kan ikke gjenbrukes for noe annet.

## 4. Policy Gateway (deterministisk)

- Alle verktøykall fra alle baner (rask, intelligent, worker, watchdog) passerer Policy Gateway.
- Beslutningsgrunnlag: identitet, tenant, memory space, capability-klasse, mandat, sesjonens tillitsmodus
  (har den rørt ubetrodd innhold?), rate limits, kostnadsbudsjett og godkjenningsobjekter.
- Utfall: `Allow` / `Deny` / `NeedsApproval` – alltid logget i append-only audit med full kontekst.
- Policyregler er kode + data under versjonskontroll, med egne tester («policytester avviser uautorisert
  klasse D» er akseptansekriterium i fase 1).

## 5. Worker-sikkerhet

- Kastbar Linux-container (Docker/WSL2) per jobb; eget filsystem og arbeidskatalog.
- Nettverksallowlist per jobbkontrakt (kun definerte mål).
- Repo- og jobbspesifikke tokens med kort levetid; ingen hovednøkler i miljøet.
- Ingen «farlig tillatelsesoverstyring» (f.eks. skip-permissions-kjøring) utenfor kastbare testmiljøer.
- Kodeendringer: branch → PR → automatiske tester → **menneskelig merge-gate** for produksjon.

## 6. Secrets

- Sentral vault (Infisical/OpenBao – valg tas i fase 1, se OPEN_QUESTIONS Q-05) som eneste kilde.
- Kortlivede identiteter og planlagt rotasjon.
- SOPS kun for krypterte konfigurasjonsfiler i Git.
- Aldri secrets i kildekode, prompt, LLM-kontekst, logger eller feilmeldinger (logg-scrubbing).
- Tjenester får secrets injisert ved oppstart/behov med minst mulig scope.

## 7. Audit og sporbarhet

- Append-only audit-logg **utenfor agentprosessen** (egen skriver, ev. egen node senere).
- Hver hendelse: person, tenant, sesjon, jobb, verktøy, policybeslutning, credential-referanse, resultat, kostnad.
- `security_incidents` for avvik; kobles til varsling med alvorlighetsgrad.

## 8. Kill switch og nødprosedyrer

- Én kommando/knapp som: stopper alle verktøykall, tilbakekaller aktive tokens, fryser jobbkøer og
  varsler Tobias. Deterministisk, uavhengig av LLM, testes jevnlig.
- Dokumentert nødtilgang (break-glass) og kontinuitetsplan for Kundeoppfølging AS.
- Watchdog kan utløse kill switch ved definerte kriterier (kostnadseksplosjon, løkkedeteksjon).

## 9. Prompt injection-forsvar i praksis

1. Ubetrodd innhold merkes ved inngang og beholder merkingen gjennom hele kjeden (proveniens).
2. Sesjoner som leser ubetrodd innhold nedgraderes automatisk (mister utgående capabilities).
3. Strukturert uttrekk (skjemavalidert) er eneste vei fra Ingestion til Reasoning/Memory.
4. Instruksjoner funnet i innhold er data, aldri kommandoer; verktøykall utledet av ubetrodd innhold
   krever forhøyet kontroll.
5. Automatisert injection-testsuite (fase 7-krav): testene forsøker eksfiltrering og uautoriserte handlinger
   og skal feile.

## 10. Autentisering og enheter

- Hver terminal har enhetsidentitet (`device_id`) med registrert nøkkel.
- `auth_strength` graderes: passiv (kjent enhet) < aktiv (PIN/biometri på enhet) < signert godkjenning.
- Stemme alene gir aldri forhøyet `auth_strength`.
- Gjester får `guest`-space med kortvarig, isolert kontekst.
