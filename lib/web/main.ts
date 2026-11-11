import { bindAddress } from "./guards.js";
import { createApp, createLlmClient } from "./server.js";

const port = Number(process.env["PORT"] ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be an integer from 1 to 65535, got "${process.env["PORT"]}".`);
  process.exit(2);
}
let host: string;
try {
  host = bindAddress(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const { client, mode } = createLlmClient();

createApp({ llm: client, mode }).listen(port, host, () => {
  console.log(`Counter running at http://${host}:${port}  (model: ${mode})`);
});
