// .ts-utvidelse kreves: filen kjøres direkte med Nodes type-stripping (ingen build-steg i fase 1)
import { createApiServer } from "./server.ts";

const port = Number(process.env["JARVIS_API_PORT"] ?? 3010);
const server = createApiServer();
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-api listening", port }));
});
