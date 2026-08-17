-- UA-3 business-event-linkage (D-57): additiv indeks for deterministisk
-- kontakt-gjenkjenning via e-postadresse (§9 i byggeordren - "provider
-- contact/email -> business_contact.email" er den PRIMÆRE deterministiske
-- nøkkelen for Gmail/Calendar-hendelseslenking). `business_contacts` hadde
-- ingen indeks på `email` fra før (kun `(tenant_id, memory_space_id,
-- company_id)`) - uten denne blir hvert synkroniseringskall en sekventiell
-- skanning av tabellen. Case-insensitiv (`lower(email)`) fordi Gmail/
-- Calendar-headere ikke garanterer konsistent store/små bokstaver.
-- Ingen skjemaendring utover indeksen selv - additiv, ingen RLS-endring.
CREATE INDEX business_contacts_email_idx ON business_contacts (tenant_id, lower(email)) WHERE email IS NOT NULL;
