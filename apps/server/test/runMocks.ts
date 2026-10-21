/** Run the stand-in services on their own (for UI checks without internet): npx tsx test/runMocks.ts */
import { startMocks } from "./mockServices.ts";
await startMocks(8093);
console.log("mock services on http://127.0.0.1:8093");
