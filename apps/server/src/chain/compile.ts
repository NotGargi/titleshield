import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";

/** Compiles contracts/*.sol with solc-js (dev dependency). The output is committed as artifacts.json. */
export const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
export const SOURCES = ["TestToken.sol", "TitleEscrow.sol"];
export const SOLC_SETTINGS = { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 } };

export async function compileContracts() {
  const solc = (await import("solc")).default as any;
  const sources = Object.fromEntries(SOURCES.map((f) => [f, { content: fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8") }]));
  const input = { language: "Solidity", sources, settings: { ...SOLC_SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  const pick = (file: string, name: string) => ({ abi: out.contracts[file][name].abi, bytecode: "0x" + out.contracts[file][name].evm.bytecode.object });
  return {
    compiler: `solc ${solc.version()}`,
    settings: SOLC_SETTINGS,
    TestToken: pick("TestToken.sol", "TestToken"),
    TitleEscrow: pick("TitleEscrow.sol", "TitleEscrow")
  };
}
