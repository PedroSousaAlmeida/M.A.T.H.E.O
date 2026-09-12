/**
 * Generates a self-signed A1-like certificate (.pfx) for local development with NFSE_ENV=fake.
 * It is NOT an ICP-Brasil certificate and will be rejected by the real national API.
 *
 * Usage: bun run scripts/dev-certificate.ts [output.pfx] [password] [cnpj]
 * Output files are git-ignored (*.pfx).
 */
import { writeFileSync } from 'node:fs';
import forge from 'node-forge';

const [output = 'dev-cert.pfx', password = 'dev-password', cnpj = '12345678000199'] = process.argv.slice(2);

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = String(Date.now());
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
const subject = [
  { name: 'commonName', value: `EMPRESA DEV LTDA:${cnpj}` },
  { name: 'countryName', value: 'BR' },
  { name: 'organizationName', value: 'ICP-Brasil (fake, dev only)' },
];
cert.setSubject(subject);
cert.setIssuer(subject);
cert.sign(keys.privateKey, forge.md.sha256.create());

const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
writeFileSync(output, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));

console.log(`wrote ${output} (password: ${password}, CN: ${subject[0].value}, valid until ${cert.validity.notAfter.toISOString().slice(0, 10)})`);
