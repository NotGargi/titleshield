import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), `titleshield-test-${process.pid}`);
const MOCK = "http://127.0.0.1:8093";

export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      PORT: "8091",
      PUBLIC_BASE_URL: "http://localhost:8091",
      WEB_BASE_URL: "http://localhost:5173",
      // A separate database: the suite clears saved settings and caches. Create it with `createdb titleshield_test`.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/titleshield_test",
      // External free services → local stand-in that speaks their published formats (test/mockServices.ts)
      TINYFISH_API_KEY: "",
      TINYFISH_SEARCH_URL: `${MOCK}/search/`,
      TINYFISH_FETCH_URL: `${MOCK}/fetch/`,
      NOMINATIM_URL: `${MOCK}/nominatim`,
      PHOTON_URL: `${MOCK}/photon`,
      PINCODE_URL: `${MOCK}/pincode`,
      GEMINI_API_KEY: "",
      GEMINI_BASE_URL: `${MOCK}/gemini`,
      TSA_ENABLED: "false",
      WORKFLOW_ENGINE: "inline",
      LOCAL_STORAGE_DIR: path.join(tmp, "worm"),
      PKI_DIR: path.join(tmp, "pki"),
      RATE_LIMIT_PER_MINUTE: "10000",
      CHAIN_MODE: "embedded",
      CHAIN_PORT: "8547",
      CHAIN_DIR: path.join(tmp, "chain")
    }
  }
});
