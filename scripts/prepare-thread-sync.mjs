import "dotenv/config";
import path from "node:path";
import { prepareThreadSync } from "../dist/thread-sync.js";

const dataDirectory = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
const sync = await prepareThreadSync(
  dataDirectory,
  Number(process.env.THREAD_SYNC_PORT ?? 6002),
);
console.log(`Load unpacked extension: ${sync.extensionDirectory}`);
console.log(`Thread sync endpoint: ${sync.bindUrl}`);
console.log("Prepared extension files only. No server or browser was started.");
