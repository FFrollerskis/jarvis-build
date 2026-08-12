import { createApiServer } from "./server.js";

const port = Number(process.env["JARVIS_API_PORT"] ?? 3010);
const server = createApiServer();
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "jarvis-api listening", port }));
});
