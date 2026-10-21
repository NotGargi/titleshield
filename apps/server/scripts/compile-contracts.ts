import fs from "node:fs";
import path from "node:path";
import { compileContracts } from "../src/chain/compile.ts";
import { SERVER_ROOT } from "../src/config.ts";

const a = await compileContracts();
const file = path.join(SERVER_ROOT, "src/chain/artifacts.json");
fs.writeFileSync(file, JSON.stringify(a, null, 1) + "\n");
console.log(`Compiled with ${a.compiler} → ${path.relative(process.cwd(), file)}`);
