// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)

/**
 * WP-G3 (D-465), review delta A INFO-D9: UA-9-flaggene i en LITEN fil UTEN imports. `provider-pause.ts` (som også lastes av worker-prosessen) trenger kun å vite om den lokale visjonsmodellen er på, og importerte
 * tidligere hele `vision-runtime.ts` for det - med pipeline, poller, lagring og HA-kilde - slik at workerens importgraf lastet visjonskode selv med alle `JARVIS_VISION_*` AV. Flaggene bor nå her; `vision-runtime.ts`
 * re-eksporterer dem uendret (eksisterende importer virker), og en vakt (wpg3-vision-runtime.test.ts) låser at `provider-pause.ts` ikke importerer `vision-runtime.ts` og at denne filen ikke har noen imports.
 * Semantikk (uendret): alle flagg er eksakt «on» for å slå PÅ; underflagg gjelder KUN under hovedbryteren `JARVIS_VISION_ENABLED`.
 */
export interface VisionFlags {
  enabled: boolean;
  classifier: boolean;
  storeSnapshots: boolean;
  haPoll: boolean;
  localUrl: string | undefined;
  localModel: string;
  storageDir: string | undefined;
}

export const flagOn = (value: string | undefined): boolean => value === "on";

export function visionFlagsFromEnv(env: NodeJS.ProcessEnv): VisionFlags {
  const enabled = flagOn(env["JARVIS_VISION_ENABLED"]);
  return {
    enabled,
    // Underflagg gjelder KUN under hovedbryteren (hovedbryter av = alt av, uansett underflagg).
    classifier: enabled && flagOn(env["JARVIS_VISION_CLASSIFIER"]),
    storeSnapshots: enabled && flagOn(env["JARVIS_VISION_STORE_SNAPSHOTS"]),
    haPoll: enabled && flagOn(env["JARVIS_VISION_HA_POLL"]),
    localUrl: env["JARVIS_VISION_LOCAL_URL"]?.trim() || undefined,
    localModel: env["JARVIS_VISION_LOCAL_MODEL"]?.trim() || "local-vision",
    storageDir: env["JARVIS_VISION_STORAGE_DIR"]?.trim() || undefined
  };
}
