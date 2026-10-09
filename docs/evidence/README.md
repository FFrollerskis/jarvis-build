# Evidens (WP-J, D-450)

Her ligger **kjørebevis** fra verifiseringsøkten for HF1/HF2: det en kommando faktisk skrev, på en navngitt kode (git-SHA), på en navngitt vert. En rad i
[`../CLOSURE_MATRIX_HF1_HF2.md`](../CLOSURE_MATRIX_HF1_HF2.md) kan **først** stå som `VERIFIED` når den lenker til en fil her (eller en URL til en uforanderlig
kjøring) – det håndheves av CI-vakten `modules/core/test/wpj-closure-matrix.test.ts`. «PASS» i en evidensfil betyr at *denne målingen* var som forventet akkurat da;
det er ikke det samme som at en masterplan-port er lukket (se vurderingsfeltet nederst i hver fil).

## Slik lager du en evidensfil

Fra repoets rot på maskinen der kommandoen skal kjøres (NAS-en for gate-kjøringer, Mac-en for Xcode-ting osv.):

```bash
node ops/acceptance/record-evidence.mjs <id> --note "kort kontekst" -- <kommando> [argumenter...]
# eksempel:
JARVIS_BACKUP_DIR=/volume1/jarvisbuild-data/backups/encrypted \
  node ops/acceptance/record-evidence.mjs ua0-gate-nas -- ops/acceptance/nas-ua0-gate.sh
# eller, når kommandoen allerede er kjørt:
ops/acceptance/nas-ua0-gate.sh | node ops/acceptance/record-evidence.mjs ua0-gate-nas --stdin
```

- Filen heter `docs/evidence/<dato>-<id>.md` og **overskrives aldri** (en ny kjøring får ny id, f.eks. `ua0-gate-nas-2`).
- Kommandoen kjøres **uten skall** (argv). Utdata over 200 kB avkortes og det står i filen.
- Kjente hemmelighetsformer (PEM, `ghp_…`, `sk-…`, JWT, Bearer, `postgres://bruker:passord@…`, `NAVN_TOKEN=…`) redigeres bort og telles. Det er en **siste sikring**, ikke en
  lisens: les filen før den committes. `gitleaks` kjører også i CI.
- Exit-koden fra kommandoen følger med (feil er også evidens). Opptakeren selv: 0 = kommandoen ga 0, 1 = kommandoen feilet (filen er skrevet), 2 = bruksfeil, 3 = filen kunne ikke skrives / finnes.

## Etterpå

1. Åpne filen og fyll ut **Vurdering** (PASS / WARN / FAIL / UNKNOWN, hvilke matriserader den gjelder, hva som *ikke* ble dekket).
2. Commit filen og lenk den fra den aktuelle raden i lukkingsmatrisen (`docs/evidence/<fil>.md`); først da kan statusen flyttes til `VERIFIED`.
3. En evidensfil som viser WARN/UNKNOWN/FAIL flytter ikke noe til `VERIFIED` – raden beholder sin status og feilen beskrives.

## Hva som ikke hører hjemme her

Hemmelighetsverdier, rå samtaleinnhold, personopplysninger, kundedata og helse-/økonomiinnhold. Evidens skal være tall, navn, tilstander og tidsstempler. Er du i tvil: lim
utdataene i chatten i stedet for å committe dem.
