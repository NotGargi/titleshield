import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import forge from "node-forge";
import { config } from "../config.ts";

/**
 * Signing material.
 *  - Document signer (PDF §7.3): a PKCS#12 holding the Class-3 organisational
 *    document-signer certificate. In development a local CA issues a stand-in
 *    certificate clearly marked DEV; in production put the CCA-issued token export
 *    (or an HSM-backed equivalent) at PKI_DIR/signer.p12.
 *  - Oracle key (PDF §6.3): Ed25519 key of the isolated TitleVerificationOracle that
 *    signs every escrow release/refund instruction. Only its public key is given to the bank.
 */

const p = (f: string) => path.join(config.PKI_DIR, f);

export function ensurePki(log = console.log) {
  fs.mkdirSync(config.PKI_DIR, { recursive: true });
  if (!fs.existsSync(p("signer.p12"))) {
    const caKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const caPriv = forge.pki.privateKeyFromPem(caKeys.privateKey.export({ type: "pkcs1", format: "pem" }) as string);
    const caPub = forge.pki.publicKeyFromPem(caKeys.publicKey.export({ type: "spki", format: "pem" }) as string);
    const sPriv = forge.pki.privateKeyFromPem(sKeys.privateKey.export({ type: "pkcs1", format: "pem" }) as string);
    const sPub = forge.pki.publicKeyFromPem(sKeys.publicKey.export({ type: "spki", format: "pem" }) as string);

    const now = new Date();
    const ca = forge.pki.createCertificate();
    ca.publicKey = caPub;
    ca.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
    ca.validity.notBefore = now;
    ca.validity.notAfter = new Date(now.getTime() + 10 * 365 * 86400 * 1000);
    const caAttrs = [{ name: "commonName", value: "TitleShield DEV Root CA (not a licensed CA)" }, { name: "organizationName", value: "TitleShield (BhoomiTrust)" }, { name: "countryName", value: "IN" }];
    ca.setSubject(caAttrs); ca.setIssuer(caAttrs);
    ca.setExtensions([{ name: "basicConstraints", cA: true, critical: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true }, { name: "subjectKeyIdentifier" }]);
    ca.sign(caPriv, forge.md.sha256.create());

    const cert = forge.pki.createCertificate();
    cert.publicKey = sPub;
    cert.serialNumber = "3a" + crypto.randomBytes(8).toString("hex");
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + 2 * 365 * 86400 * 1000);
    cert.setSubject([
      { name: "commonName", value: "TitleShield Document Signer (Class-3 DEV)" },
      { name: "organizationName", value: "TitleShield (BhoomiTrust)" },
      { name: "organizationalUnitName", value: "Title Verification Oracle" },
      { name: "stateOrProvinceName", value: "Maharashtra" },
      { name: "countryName", value: "IN" }
    ]);
    cert.setIssuer(caAttrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
      { name: "extKeyUsage", emailProtection: true },
      { name: "subjectKeyIdentifier" },
      { name: "authorityKeyIdentifier", keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() }
    ]);
    cert.sign(caPriv, forge.md.sha256.create());

    const p12 = forge.pkcs12.toPkcs12Asn1(sPriv, [cert, ca], config.SIGNER_P12_PASSWORD, { algorithm: "aes256" });
    fs.writeFileSync(p("signer.p12"), Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"));
    fs.writeFileSync(p("signer.crt"), forge.pki.certificateToPem(cert));
    fs.writeFileSync(p("ca.crt"), forge.pki.certificateToPem(ca));
    log(`generated development signing PKI in ${config.PKI_DIR}`);
  }
  if (!fs.existsSync(p("oracle.key.pem"))) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(p("oracle.key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(p("oracle.pub.pem"), publicKey.export({ type: "spki", format: "pem" }));
    log("generated Ed25519 oracle key");
  }
}

let signerCache: { p12: Buffer; serial: string; subject: string; issuer: string; certPem: string; notAfter: string } | null = null;

export function loadSigner() {
  if (signerCache) return signerCache;
  ensurePki();
  const certPem = fs.readFileSync(p("signer.crt"), "utf8");
  const cert = forge.pki.certificateFromPem(certPem);
  const cn = (attrs: forge.pki.CertificateField[]) => attrs.find((a) => a.name === "commonName")?.value as string;
  signerCache = {
    p12: fs.readFileSync(p("signer.p12")),
    serial: cert.serialNumber.toUpperCase(),
    subject: cn(cert.subject.attributes),
    issuer: cn(cert.issuer.attributes),
    certPem,
    notAfter: cert.validity.notAfter.toISOString()
  };
  return signerCache;
}

export function oracleKeys() {
  ensurePki();
  return {
    privateKey: crypto.createPrivateKey(fs.readFileSync(p("oracle.key.pem"))),
    publicKeyPem: fs.readFileSync(p("oracle.pub.pem"), "utf8")
  };
}

export function caCertPem() {
  ensurePki();
  return fs.readFileSync(p("ca.crt"), "utf8");
}
