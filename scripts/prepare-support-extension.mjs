import "dotenv/config";
import path from "node:path";
import { prepareThreadSync } from "../dist/thread-sync.js";

const dataDirectory = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
const sync = await prepareThreadSync(
  dataDirectory,
  Number(process.env.THREAD_SYNC_PORT ?? 6002),
);
console.log(`Load unpacked extension: ${sync.extensionDirectory}`);
console.log(`Local Codex support endpoint: ${sync.bindUrl.replace("/thread-sync/bind", "")}`);
console.log("Prepared the Local Codex Support extension only. No server or browser was started.");
