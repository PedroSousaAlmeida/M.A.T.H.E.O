import { describe, expect, it } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { CertificateVault } from '@/modules/nfse/crypto/certificate-vault';

const KEY_A = '11'.repeat(32);
const KEY_B = '22'.repeat(32);

function vaultWithKey(key: string) {
  const config = { get: () => key } as unknown as ConfigService<any, true>;
  return new CertificateVault(config);
}

describe('CertificateVault', () => {
  it('round-trips a buffer', () => {
    const vault = vaultWithKey(KEY_A);
    const plain = Buffer.from('certificate-bytes');
    expect(vault.decrypt(vault.encrypt(plain)).equals(plain)).toBe(true);
  });

  it('round-trips a string as base64', () => {
    const vault = vaultWithKey(KEY_A);
    const payload = vault.encryptString('s3cret');
    expect(typeof payload).toBe('string');
    expect(vault.decryptString(payload)).toBe('s3cret');
  });

  it('produces different payloads for the same input (random iv)', () => {
    const vault = vaultWithKey(KEY_A);
    const plain = Buffer.from('same');
    expect(vault.encrypt(plain).equals(vault.encrypt(plain))).toBe(false);
  });

  it('fails to decrypt with another key', () => {
    const payload = vaultWithKey(KEY_A).encrypt(Buffer.from('x'));
    expect(() => vaultWithKey(KEY_B).decrypt(payload)).toThrow();
  });

  it('fails to decrypt a tampered payload', () => {
    const vault = vaultWithKey(KEY_A);
    const payload = vault.encrypt(Buffer.from('x'));
    payload[payload.length - 1] ^= 0xff;
    expect(() => vault.decrypt(payload)).toThrow();
  });
});
