/**
 * WP-AUTH2a: adapterne som eies av tool-gateway selv (leverandør-connectorer med eksisterende lese-handlinger). Domene-eide adaptere (vekst, forretning) bor i sine egne moduler og settes sammen i `apps/api/src/class-c-wiring.ts`.
 * Dekningstabellen (alle klasse C-handlinger: dekket/utsatt) står i `class-c-coverage.ts`.
 */
import type { ClassCAdapter } from "./class-c-pipeline.ts";
import { driveClassCAdapters } from "./class-c-adapter-drive.ts";
import { githubCreatePrAdapter } from "./class-c-adapter-github.ts";

export { githubCreatePrAdapter } from "./class-c-adapter-github.ts";
export { driveClassCAdapters, driveCreateFileAdapter, driveMoveAdapter, driveRenameAdapter, driveTrashAdapter, driveUpdateContentAdapter } from "./class-c-adapter-drive.ts";

export function defaultClassCAdapters(): ClassCAdapter[] {
  return [githubCreatePrAdapter, ...driveClassCAdapters()];
}
