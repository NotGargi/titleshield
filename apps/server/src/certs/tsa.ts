import crypto from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { config } from "../config.ts";

/**
 * RFC 3161 Trusted Timestamping (PDF §7.2): the hourly Merkle root is sent to a
 * Time-Stamp Authority; the signed TimeStampResp token proves the root existed at
 * that time. Default TSA is FreeTSA; production would use a CCA-licensed TSA.
 */

const SHA256_OID = "2.16.840.1.101.3.4.2.1";

export function buildTimeStampRequest(hashHex: string): Buffer {
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
      hashedMessage: new asn1js.OctetString({ valueHex: Buffer.from(hashHex, "hex") })
    }),
    nonce: new asn1js.Integer({ valueHex: crypto.randomBytes(8) }),
    certReq: true
  });
  return Buffer.from(req.toSchema().toBER(false));
}

export async function timestamp(hashHex: string): Promise<{ token: Buffer | null; status: string }> {
  if (!config.TSA_ENABLED) return { token: null, status: "DISABLED" };
  try {
    const res = await fetch(config.TSA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: new Uint8Array(buildTimeStampRequest(hashHex)),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { token: null, status: `HTTP_${res.status}` };
    const body = Buffer.from(await res.arrayBuffer());
    const asn = asn1js.fromBER(new Uint8Array(body).buffer);
    const resp = new pkijs.TimeStampResp({ schema: asn.result });
    const st = resp.status.status;
    return { token: st === 0 || st === 1 ? body : null, status: st === 0 || st === 1 ? "GRANTED" : `REJECTED_${st}` };
  } catch (e) {
    return { token: null, status: `UNAVAILABLE: ${(e as Error).message.slice(0, 60)}` };
  }
}
