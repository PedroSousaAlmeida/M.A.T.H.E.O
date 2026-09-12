import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../../../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

@Injectable()
export class CertificateVault {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const encryptionKey = config.get('CERT_ENCRYPTION_KEY', { infer: true });
    this.key = Buffer.from(encryptionKey, 'hex');
  }

  encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): Buffer {
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  encryptString(text: string): string {
    return this.encrypt(Buffer.from(text, 'utf8')).toString('base64');
  }

  decryptString(payload: string): string {
    return this.decrypt(Buffer.from(payload, 'base64')).toString('utf8');
  }
}
