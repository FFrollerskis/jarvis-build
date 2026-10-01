-- D-358 (Tobias direkte i chat: "Først fiks ferdig resten av minne" - oppfølging
-- av D-357s FUNNET-men-ikke-fikset GDPR-erasure/append-only-trigger-konflikt).
--
-- `memory_versions` sin `forbid_mutation()`-trigger (008_memory.sql) blokkerte
-- `modules/erasure/src/plan.ts` sin rå `DELETE FROM memory_versions` UNNTAKSLØST -
-- enhver GDPR-slettingsforespørsel for en person med MINST ÉN versjonert
-- minnefakta-rad (dvs. et faktum som noensinne ble oppdatert ELLER invalidert,
-- et STADIG VANLIGERE tilfelle etter D-357s re-add-etter-invalidert-fiks) kastet
-- og rullet HELE slettingen tilbake.
--
-- `forbid_mutation()` er DELT av `events` (002), `audit` (004) og `memory_versions`
-- (008) - ALLE append-only av samme grunn ("skjules aldri"-prinsippet). `events`/
-- `audit` er BEVISST ALDRI et erasure-mål (grep-bekreftet: `plan.ts` rører dem
-- ikke) - de skal derfor ALDRI kunne muteres, uansett kontekst. KUN
-- `memory_versions` trenger en kontrollert unntaksvei, siden DEN faktisk er et
-- erasure-mål. Fiksen er derfor BEVISST navngitt på BÅDE tabellnavn
-- (`TG_TABLE_NAME = 'memory_versions'`) OG en transaksjonslokal GUC
-- (`jarvis.erasure_in_progress`, satt via `set_config(..., true)` - SAMME
-- "is_local"-mønster som `jarvis.tenant_id`/`jarvis.memory_spaces`,
-- `modules/erasure/src/context.ts` - forsvinner automatisk ved COMMIT/ROLLBACK,
-- lekker ALDRI til en senere transaksjon) - en fremtidig `events`/`audit`-mutasjon
-- ville FORTSATT blitt avvist selv om noen (feilaktig) satte samme GUC under en
-- annen operasjon, siden tabellnavnet også må stemme. Flagget settes KUN av
-- `ErasureService.executeErasure()` sin "delete"-gren (ALDRI "count"/preview,
-- som uansett aldri muterer noe) - se `erasure-service.ts`.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'memory_versions' AND current_setting('jarvis.erasure_in_progress', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'append_only_table: % tillater ikke %', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
