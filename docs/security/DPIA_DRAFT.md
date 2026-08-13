# Jarvis – DPIA-utkast (fase 1)

**Status:** UTKAST v0.1 – fylles ut per fase; taledelen fullføres i fase 5 **før** noen
STT/TTS-skyleverandør tas i bruk. Referanse: Datatilsynets DPIA-veileder (lenke i masterplanen §16).

## 1. Behandlingens art og formål

Jarvis er Tobias sin personlige AI-assistent: samtaler, minne, oppgaver, hjemstyring og
bedriftsstøtte (Kundeoppfølging AS). Formål per datakategori dokumenteres løpende her.

| Datakategori | Memory space | Formål | Fase |
|---|---|---|---|
| Samtalehistorikk (tekst) | personal/project | Kontinuitet, minne, assistanse | 3+ |
| Personlige dokumenter | personal | Gjenfinning, assistanse | 4+ |
| Bedriftsdata (kunder, e-post) | business | Drift av Kundeoppfølging AS | 7+ |
| Helseopplysninger | health | Kun eksplisitt ønsket støtte | senere, egen vurdering |
| Talelyd | (transient) | Sanntidssamtale | 5+ |
| Hjemdata (sensorer, tilstedeværelse) | home | Hjemstyring | 9+ |
| Gjestedata | guest | Kortvarig kontekst | 9+ |

## 2. Rettslig ramme (foreløpig vurdering)

- Privat bruk av egne data faller i utgangspunktet under privat/husholdningsunntaket, **men**
  bedriftsdata (Kundeoppfølging AS) gjør Tobias/selskapet behandlingsansvarlig med fullt GDPR-ansvar –
  databehandleravtaler og region-/retensjonsmatrise kreves før fase 7.
- Talelyd er personopplysninger. Stemme blir biometriske særkategoridata (art. 9) først når den
  behandles for entydig identifisering – Jarvis skal ikke gjøre det; stemmeprofil brukes aldri som
  eneste autentisering (arkitekturinvariant).
- Lyd kan likevel avsløre sensitive forhold → taledelen av DPIA (fase 5) skal dekke: formål,
  behandlingsgrunnlag, region, retensjon, modelltrening hos leverandør, sletting, kryptering, og om
  rå lyd forlater huset.

## 3. Risikoer og tiltak (initielt)

| Risiko | Alvor | Tiltak |
|---|---|---|
| Lekkasje av privat minne til ekstern modell | Høy | Space-basert ruting (D-23): sensitive spaces → lokal/minimert; pseudonymisering før eksterne kall (fase 3+) |
| Kryss-tenant-lekkasje (privat ↔ bedrift) | Høy | RLS + separate nøkler (fase 2); eval med null-lekkasje-krav (fase 4) |
| Kontinuerlig romavlytting | Høy | Ingen kontinuerlig lagring av rå romlyd; lokal wake-word/VAD; fysisk mute; lytteindikator (fase 5/9) |
| Gjesters personvern | Middels | Gjestemodus uten privat minne; synlig indikator (fase 9) |
| Leverandør trener på data | Middels | Databehandleravtale + trenings-/retensjonsvilkår per leverandør i [PROCESSOR_REGION_MATRIX.md](PROCESSOR_REGION_MATRIX.md) før bruk |
| Manglende sletting | Middels | Retensjonsregel obligatorisk per minne; sletting i alle lag med audit-spor (fase 4) |

## 4. Registrertes rettigheter

Innsyn, retting, eksport og sletting implementeres i minnesystemet (fase 4): menneskelesbar eksport,
versjonering, kryptografisk/hard sletting i alle lag. For bedriftsdata gjelder dette også kunders data.

## 5. Gjenstående før DPIA kan ferdigstilles

- [ ] Leverandørvalg (LLM/STT/TTS/realtime) med region og vilkår (fase 3/5-benchmark)
- [ ] Taledelen komplett (fase 5-port)
- [ ] Databehandleravtaler for bedriftsdata (før fase 7)
- [ ] Retensjonsmatrise per datakategori (fase 4)
- [ ] Vurdering av helse-space (utsatt; egen beslutning kreves)
