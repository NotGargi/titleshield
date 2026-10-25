/** Generate the development signing PKI and oracle key (`npm run pki`). */
import { ensurePki, loadSigner } from "../crypto/pki.ts";
ensurePki();
const s = loadSigner();
console.log(`Signer: ${s.subject} · serial ${s.serial} · issued by ${s.issuer} · valid until ${s.notAfter}`);
