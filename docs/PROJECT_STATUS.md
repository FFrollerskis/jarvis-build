# Jarvis – prosjektstatus

**Sist oppdatert:** 2026-08-12
**Aktiv branch:** `claude/fase-0-github-og-statusfiler`
**Nyeste commit:** oppdateres ved commit (se `git log --oneline -1`)

## Nåsituasjon

- **Hovedfase:** Fase 0 – spesifikasjon og prosjektetablering (ferdig innhold; venter på godkjenning av fase 1)
- **Nåværende deloppgave:** GitHub-etablering, statusfiler og overleveringsrutine
- **Samlet fremdrift:** Spesifikasjon 100 % · Implementering 0 % (0 av 10 faser påbegynt)

Fremdrift regnes mot leveransene og akseptansekriteriene i
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) – ikke som løst anslag.

## Fasestatus

| Fase | Innhold | Status |
|---|---|---|
| 0 | Spesifikasjon, dokumentasjon, GitHub-etablering | ✅ Ferdig (denne økten avslutter den) |
| 1 | Kjørbart sikkerhets- og prosjektfundament | ⛔ Ikke startet – **venter på Tobias sin godkjenning** |
| 2 | Identitet, kontrakter og datafundament | ⛔ Ikke startet |
| 3 | Jarvis Core og tekst-MVP | ⛔ Ikke startet |
| 4 | Hybridminne v1 | ⛔ Ikke startet |
| 5 | Voice Gateway vertikal prototype | ⛔ Ikke startet |
| 6 | Oppgaver og isolerte workers | ⛔ Ikke startet |
| 7 | Første integrasjoner | ⛔ Ikke startet |
| 8 | Mobil, Watch og kontinuitet | ⛔ Ikke startet |
| 9 | Home Assistant, hus og steder | ⛔ Ikke startet |
| 10 | Drift, skalering og egen infrastruktur | ⛔ Ikke startet |

## Ferdige leveranser

- Masterplan v2.1 konvertert til markdown: `docs/input/01_Jarvis_Masterplan_v2.1.md`
- Kanonisk spesifikasjon og 8 arkitektur-/plandokumenter i `docs/`
- Kritisk gjennomgang: 12 funn (K-01–K-12), 17 beslutninger (D-xx), 6 antakelser (A-xx)
- Ti-fase implementeringsplan med tester, akseptansekriterier og «Bygges IKKE»-lister
- `CLAUDE.md` med prosjektregler og samarbeidsprotokoll
- Git-repo initialisert; remote `origin` → `https://github.com/tsworkflow/jarvisbuild.git`
- Statusfiler: `PROJECT_STATUS.md`, `SESSION_LOG.md`, `HANDOFF_REPORT.md`

## Pågående arbeid

- Push av `claude/fase-0-github-og-statusfiler` til GitHub og overlevering til ekstern AI-arkitekt.

## Gjenstående arbeid (nærmeste)

1. Tobias: svare på Q-01 (manglende kildedokumenter) og Q-02 (antakelser A-01–A-06)
2. Tobias: godkjenne fase 1-innholdet
3. Tobias: godkjenne at `main` pushes til GitHub som baseline (bootstrap av tomt repo)
4. Deretter: fase 1-implementering på `claude/fase-1-security-foundation`

## Aktive blokkeringer

- **Push til GitHub blokkert (403):** lagret Windows-credential tilhører GitHub-kontoen `post-ops`,
  som ikke har tilgang til `tsworkflow/jarvisbuild`. Tobias må enten gi `post-ops` tilgang, bytte
  credential i Windows Credential Manager, eller installere `gh` og logge inn med riktig konto.
  Alt arbeid er committet lokalt.
- **Push til `main`:** krever uttrykkelig godkjenning fra Tobias (regel i samarbeidsprotokollen);
  repoet på GitHub er tomt inntil da.
- **SSH til GitHub:** «Permission denied (publickey)» – ingen SSH-nøkkel er konfigurert for
  `git@github.com`. HTTPS brukes i stedet.
- **GitHub CLI (`gh`) er ikke installert:** kan ikke verifisere at repoet er privat, og kan ikke
  opprette Pull Request automatisk. Rapportert til Tobias.

## Kjente feil

- Ingen (ingen kode eksisterer ennå).

## Teknisk gjeld

- Ingen kodegjeld. Dokumentgjeld: eval-settet i fase 4 må bygges fra syntetisk start (K-09);
  masterplanens refererte sluttrapport/serverplattform-dokumenter mangler i `docs/input` (K-08).

## Åpne beslutninger

Se [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md): Q-01/Q-02 haster (før fase 1); Q-03–Q-12 avgjøres av
måling i senere faser.

## Neste anbefalte oppgave

Fase 1: **Kjørbart sikkerhets- og prosjektfundament** – etter godkjenning fra Tobias.
Branch: `claude/fase-1-security-foundation`. Innhold og akseptansekriterier:
[IMPLEMENTATION_PLAN.md → Fase 1](IMPLEMENTATION_PLAN.md#fase-1--kjørbart-sikkerhets--og-prosjektfundament-12-uker).
