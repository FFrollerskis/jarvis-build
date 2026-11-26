/**
 * @jarvis/empire (WP-MCE0): REN kjerne for Empire-laget (HF4 §03-§07). Ingen DB, ingen nettverk, ingen fil-I/O, ingen nøkkelhåndtering, ingen
 * klokke/tilfeldighet (alt injiseres), ingen importør i apps/* ennå. Empire er KUN en grant og en cache over MC-lagets organisasjoner/sesjoner
 * (org = tenant): pakken eier ikke identitet, credentials, ACL, selskapsdata eller varig kryssselskapsminne.
 */
export * from "./tiers.ts";
export * from "./tier-change.ts";
