# Fase 8 – sjekkliste for Mac mini (Tobias, i morgen)

Alt backend + Swift-kildekode ligger klart i `apps/mobile/`. Swift-koden er IKKE kompilert
(krever Xcode) – forvent små kompileringsfikser første gang.

## Forutsetninger
1. macOS med **Xcode 16+** (App Store) + kommandolinjeverktøy (`xcode-select --install`).
2. **Apple Developer-konto** (gratis holder for lokal enhetstest; betalt kreves for TestFlight/push).
3. Valgfritt: `brew install xcodegen` (genererer prosjektet fra `apps/mobile/project.yml`).
4. Jarvis-backend kjørende på PC/NAS i samme nett (`pnpm --filter @jarvis/api dev` med DB-konfig;
   noter LAN-IP → brukes som server-URL i appen).

## Steg
1. Klon repoet på Mac-en; `cd apps/mobile && xcodegen generate && open Jarvis.xcodeproj`
   (alternativ: File → New → Project i Xcode og dra inn `Sources/`-mappene; targets iOS + watchOS).
2. **Signing & Capabilities** per target: velg Team; bundle-IDer
   `com.tsworkflow.jarvis.ios` og `.watch` (endre prefiks om ønskelig).
3. Bygg **JarvisiOS** mot simulator først; sett server-URL i appen (AppStorage `jarvis.server`).
4. Verifiser: helse, chat («status» → rute fast), **samme session_id som webchatten** (web↔iPhone-kontinuitet).
5. Enhetsoppsett kjører automatisk: registrering + challenge (🔐 i tittel = enheten er bevist).
6. **Klasse D-test:** «Godkjenn demo (D)» → ALLOW; trykk igjen med samme godkjenning er umulig
   (ny nonce per trykk — replay-vern ligger server-side og er allerede testet).
7. Bygg **JarvisWatch** (simulator, så fysisk klokke): Status-knapp + Godkjenn (D) fra klokken.
8. **Fysisk enhet:** kjør på iPhone (kabel/nettverk); test web↔iPhone↔Watch-kontinuitet reelt.
9. **Push (krever betalt konto):** aktiver Push Notifications-capability; opprett APNs-nøkkel (.p8)
   i developer-portalen; backend-adapteren `ApnsPushAdapter` skal så implementeres/konfigureres
   (nøkkel via SecretProvider — ALDRI i repo). Test varsel på låst telefon.
10. **Secure Enclave (senere):** klienten bruker Ed25519 i Keychain nå (kompatibel med backend).
    SecureEnclave.P256 krever ECDSA-støtte i backendens approval-verifier — egen liten backend-endring
    før byttet; ikke gjør det i morgen.
11. Rapporter resultatene → fase 8-akseptanse oppdateres (fysisk verifikasjon av kriterium 1–3).

## Mangler fortsatt (etter i morgen hvis ikke gjort)
- APNs-nøkkel/betalt konto (kriterium 3), TestFlight-distribusjon, App Intents/Live Activity
  (kan legges til når basisappen bygger), AirPods-taleklient (fase 5-gatewayen er klar for WS-klient).
