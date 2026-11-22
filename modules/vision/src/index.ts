export * from "./types.ts";
export * from "./service.ts";
// D-396 (JARVIS-093): test-/fake-kilden eksporteres IKKE fra pakkens offentlige barrel (importer ../src/fake-source.ts direkte i tester) -
// ellers kan produksjonskode ved en feil koble inn en fake-kilde. Det samme gjelder alle testdobler for WP-G3 (de ligger under test/support/).
export * from "./sweep.ts";
// WP-G3 (D-465): UA-9 kilde-adaptere, lagring, klassifisering, embeddings, inventar, «sist sett», datapolicy og iPhone-kontrakt.
export * from "./labels.ts";
export * from "./image.ts";
export * from "./storage.ts";
export * from "./policy.ts";
export * from "./classifier.ts";
export * from "./source.ts";
export * from "./ha-source.ts";
export * from "./cameras.ts";
export type { VisionChangeProvenance } from "./audit.ts";
export * from "./snapshots.ts";
export * from "./inventory.ts";
export * from "./embeddings.ts";
export * from "./last-seen.ts";
export * from "./pipeline.ts";
export * from "./capture.ts";
export * from "./poller.ts";
