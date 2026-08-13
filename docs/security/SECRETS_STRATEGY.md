# Jarvis – secrets-strategi (fase 1)

**Status:** v1.0. Følger beslutning D-16. Regel null: **hemmeligheter finnes aldri i kildekode,
prompts, logger, tester, eksempelkonfig eller commits.**

## Fase 1 (nå)

| Mekanisme | Bruk |
|---|---|
| `.env` (git-ignorert) | Lokale, ufarlige innstillinger (porter, miljønavn). Ingen API-nøkler finnes i fase 1 i det hele tatt |
| `.env.example` | Committes; dokumenterer variabler UTEN verdier/secrets |
| SOPS + age | Krypterte konfigfiler under `config/secrets/` når de første reelle secrets kommer (fase 3: modellnøkler). `.sops.yaml` har placeholder til reell age-mottaker genereres |
| age-privatnøkkel | Lagres UTENFOR repoet (passordhåndterer + offline kopi); `key.txt`/`*.agekey` er git-ignorert som ekstra vern |
| gitleaks i CI | Skanner hele historikken på hver push/PR; rød CI ved funn |
| Testnøkler | Kryptonøkler i tester genereres i minnet per kjøring (`generateKeyPairSync`) – aldri sjekket inn, aldri gjenbrukt |

## Senere (D-16)

Sentral vault (Infisical eller OpenBao – valg står åpent, Q-05) innføres når flere
tjenester/prosesser faktisk trenger delte secrets, og **senest før eksterne integrasjoner gjør det
nødvendig (fase 7)**. Da: kortlivede identiteter, rotasjon, secrets injisert ved oppstart med minst
mulig scope. SOPS beholdes kun for kryptert konfig i Git.

## Hvis en secret likevel lekker

1. Aktiver kill switch ved behov.
2. Roter/tilbakekall nøkkelen hos leverandøren umiddelbart.
3. Fjern den fra historikken er IKKE nok (repoet kan være klonet) – rotasjon er det eneste som teller.
4. Logg hendelsen som security incident; oppdater gitleaks-regler hvis mønsteret ikke ble fanget.
