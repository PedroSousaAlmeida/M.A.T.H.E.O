import { Module } from '@nestjs/common';
import { CertificateVault } from './crypto/certificate-vault';

@Module({
  providers: [CertificateVault],
  exports: [CertificateVault],
})
export class NfseModule {}
