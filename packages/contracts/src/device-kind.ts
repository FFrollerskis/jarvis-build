import { z } from "zod";
import { ChannelSchema, type Channel } from "./identity.ts";

/**
 * WP-S1 (JARVIS-111, Q-71): LUKKET ENHETSTYPE og den server-side tabellen enhetstype -> tillatte kanaler. DEN ENE kilden: `@jarvis/core` (autorisasjonskjernen og innrulleringen), `@jarvis/tool-gateway`
 * (step-up-regelen) og vaktene leser alle herfra; ingen annen fil har sin egen kopi av listen.
 *
 * PROBLEMET: `POST /session/authorize` tok `channel` fra klienten og ga `auth_strength: "signed"` til enhver gyldig enhetssignatur, uansett kanal. Step-up (`ownerStepUpDenial`) godtar `signed` fra
 * `web`/`desktop`/`api`/`mobile`, så en kompromittert Watch, talegateway eller Telegram-bro kunne PÅSTÅ `web` og passere step-up. Kanalen var en påstand fra en klient med en gyldig nøkkel.
 *
 * LØSNINGEN: typen (`devices.device_kind`) settes KUN av serveren ved innrulling (innrullingsbilletten bærer den; klienten kan ikke velge eller endre den), og serveren nekter en kanal som ikke hører til typen
 * (`channel_not_allowed_for_device_kind`, aldri en stille nedgradering). `OWNER_STEP_UP_CHANNELS` forblir en egen regel: kanal -> step-up er POLICY, enhetstype -> kanal er AUTORISASJON, og de to komponerer.
 *
 * INVARIANT (låst av `device-kind.test.ts`): ingen enhetstype med en lavtillits-rolle (`watch`, `voice_gateway`, `telegram_gateway`, `service`) har en step-up-kanal, og `legacy_unknown` har ingen.
 */

/** `legacy_unknown` = eksisterende enhet hvis fritekst-`kind` ikke er en kjent førstepartsverdi, eller en billett uten type. Kan aldri gi en økt som oppfyller step-up. */
export const DEVICE_KINDS = [
  "iphone", "mac", "windows", "web_browser", "watch", "voice_gateway", "telegram_gateway", "api_client", "service", "legacy_unknown"
] as const;
export const DeviceKindSchema = z.enum(DEVICE_KINDS);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

/** Typene en innrullingsbillett kan tildele: alt unntatt `legacy_unknown` (den er en tilstand, ikke noe eieren velger). */
export const ENROLLABLE_DEVICE_KINDS = ["iphone", "mac", "windows", "web_browser", "watch", "voice_gateway", "telegram_gateway", "api_client", "service"] as const;
export const EnrollableDeviceKindSchema = z.enum(ENROLLABLE_DEVICE_KINDS);
export type EnrollableDeviceKind = z.infer<typeof EnrollableDeviceKindSchema>;

/**
 * Hvem som bestemte typen (revisjon av tilliten til selve typen). `legacy_label` = utledet av den klient-oppgitte fritekstverdien som ble lagret FØR WP-S1: IKKE verifisert av en eier-handling, og eieren skal
 * gjennomgå slike rader før `enforce` (runbook). `enrollment_ticket` = eieren valgte typen da billetten ble utstedt. `trusted_provisioning` = server-side kode (seed). `unclassified` = ingen informasjon (`legacy_unknown`).
 */
export const DEVICE_KIND_SOURCES = ["unclassified", "legacy_label", "enrollment_ticket", "trusted_provisioning"] as const;
export const DeviceKindSourceSchema = z.enum(DEVICE_KIND_SOURCES);
export type DeviceKindSource = z.infer<typeof DeviceKindSourceSchema>;

/**
 * Kanalene eieren selv sitter foran en innrullert enhet i (WP-F1, D-462). ALDRI tale, Telegram, meldingsplattformer, klokke eller system. Felles kilde for API-rutenes step-up og gatewayens egen håndhevelse
 * (`@jarvis/tool-gateway` re-eksporterer denne uendret, så eksisterende importører og tester ser samme navn og samme mengde).
 */
export const OWNER_STEP_UP_CHANNELS: ReadonlySet<string> = new Set(["web", "desktop", "api", "mobile"]);

/**
 * Enhetstype -> kanalene serveren tillater at typen autoriserer. Begrunnelsene (kodebevis i runbooken §2):
 *  - `iphone` -> mobile: iOS-appen ber om `mobile` (`apps/mobile/Sources/JarvisiOS/JarvisApp.swift`).
 *  - `mac`/`windows` -> desktop: lokal desktop-agent (kontrakt: `ChannelSchema`, D-292); ingen annen kanal.
 *  - `web_browser` -> web OG voice: nettleserens `voice.html` beviser SAMME nøkkel/enhet som dashbordet mot talegatewayen (`apps/web/voice.html` -> `/voice/session/authorize`, kanal `voice`). Uten `voice` ville
 *    taleflaten i nettleseren slutte å virke i `enforce`. `voice` oppfyller aldri step-up og er en SMALERE flate enn `web`, så en høytillits-type som i tillegg kan velge en snevrere kanal gir ingen eskalering.
 *  - `watch` -> watch, `voice_gateway` -> voice, `telegram_gateway` -> telegram, `service` -> system: lavtillits-roller, ingen step-up-kanal.
 *  - `api_client` -> api: eierens egne skript/CLI-klienter (eierflater som `FINANCE_D_CHAIN.md` henter grant via `/session/authorize` med kanal `api`).
 *  - `slack`/`discord`/`twilio`: INGEN type tillater dem (ingen kodevei bruker dem med enhetsbevis: de er transporter, D-292/D-294/D-295). `legacy_unknown` beholder dem (dagens oppførsel).
 */
export const DEVICE_KIND_CHANNELS: Readonly<Record<Exclude<DeviceKind, "legacy_unknown">, readonly Channel[]>> = Object.freeze({
  iphone: Object.freeze(["mobile"] as const),
  mac: Object.freeze(["desktop"] as const),
  windows: Object.freeze(["desktop"] as const),
  web_browser: Object.freeze(["web", "voice"] as const),
  watch: Object.freeze(["watch"] as const),
  voice_gateway: Object.freeze(["voice"] as const),
  telegram_gateway: Object.freeze(["telegram"] as const),
  api_client: Object.freeze(["api"] as const),
  service: Object.freeze(["system"] as const)
});

/** `legacy_unknown`: dagens oppførsel for alle kanaler som IKKE er en step-up-kanal; aldri en step-up-kanal. */
const LEGACY_UNKNOWN_CHANNELS: readonly Channel[] = Object.freeze(ChannelSchema.options.filter((c) => !OWNER_STEP_UP_CHANNELS.has(c)));

export function allowedChannelsForDeviceKind(kind: DeviceKind): readonly Channel[] {
  return kind === "legacy_unknown" ? LEGACY_UNKNOWN_CHANNELS : DEVICE_KIND_CHANNELS[kind];
}

/**
 * Fail-closed: en ukjent/ugyldig type (f.eks. en verdi lest fra databasen som ikke står i den lukkede listen) eller kanal er ALDRI tillatt. Typen er `unknown` med vilje: den kommer fra en databasekolonne
 * og skal ikke kunne krasje oppslaget eller gi en tilfeldig sann verdi.
 */
export function channelAllowedForDeviceKind(kind: unknown, channel: unknown): boolean {
  const k = DeviceKindSchema.safeParse(kind);
  const c = ChannelSchema.safeParse(channel);
  if (!k.success || !c.success) return false;
  return allowedChannelsForDeviceKind(k.data).includes(c.data);
}

/** Kan typen få en økt som oppfyller step-up (har den minst én eier-kanal)? Brukes av innrullingsregelen «en lavtillits-enhet kan ikke re-nøkle en høytillits-enhet». Ukjent type = `false`. */
export function deviceKindHoldsStepUpChannel(kind: unknown): boolean {
  const k = DeviceKindSchema.safeParse(kind);
  return k.success && allowedChannelsForDeviceKind(k.data).some((c) => OWNER_STEP_UP_CHANNELS.has(c));
}

/**
 * Eldre klient-oppgitte fritekstverdier (`devices.kind`, lagret FØR WP-S1) -> lukket type. KUN verdiene førstepartsklientene faktisk skriver (`web` fra nettsidene, `iphone`/`watch` fra appene, `service`/`voice` fra seed)
 * og de lukkede navnene selv; alt annet (`phone`, `pc`, `mobile`, `desktop-agent`, `api`, ...) er tvetydig og blir `legacy_unknown`. SAMME avbildning som CASE-uttrykket i migrasjon 149 (en test kjører begge mot samme
 * verdier). Brukes også til å sammenligne den klient-PÅSTÅTTE verdien i en innrullingsforespørsel med typen serveren faktisk bestemte (kun revisjon, aldri autoritet).
 */
const LEGACY_LABELS: Readonly<Record<string, DeviceKind>> = Object.freeze({
  web: "web_browser", voice: "voice_gateway", iphone: "iphone", mac: "mac", windows: "windows", web_browser: "web_browser", watch: "watch",
  voice_gateway: "voice_gateway", telegram_gateway: "telegram_gateway", api_client: "api_client", service: "service"
});
export function deviceKindFromLegacyLabel(label: unknown): { device_kind: DeviceKind; mapped: boolean } {
  if (typeof label !== "string") return { device_kind: "legacy_unknown", mapped: false };
  // Kun ASCII-bokstaver/understrek etter at vanlige mellomrom i endene er fjernet: samme avgrensning som `lower(btrim(kind))` i migrasjon 149 (ingen Unicode-/blank-tegn-forskjeller mellom SQL og kode).
  const trimmed = label.replace(/^ +| +$/g, "");
  if (!/^[A-Za-z_]{1,32}$/.test(trimmed)) return { device_kind: "legacy_unknown", mapped: false };
  const key = trimmed.toLowerCase();
  const known = Object.hasOwn(LEGACY_LABELS, key) ? LEGACY_LABELS[key] : undefined;
  return known === undefined ? { device_kind: "legacy_unknown", mapped: false } : { device_kind: known, mapped: true };
}

/**
 * Visning av en type/etikett i REVISJON og status: kun synlig ASCII, maks 40 tegn; en verdi som ikke er en streng vises som `invalid`. Revisjonen og statusflatene skal aldri kunne få en vilkårlig stor eller
 * kontrolltegn-fylt klientverdi (etiketten i en innrullingsforespørsel er ubetrodd tekst).
 */
export function displayKindLabel(label: unknown): string {
  return typeof label === "string" ? label.replace(/[^\x21-\x7e]/g, "?").slice(0, 40) : "invalid";
}

