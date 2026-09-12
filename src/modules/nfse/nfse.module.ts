import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { CertificateVault } from './crypto/certificate-vault';
import { FakeNfseGateway } from './fake-nfse.gateway';
import { NFSE_GATEWAY } from './nfse-gateway';

const gatewayProvider: Provider = {
  provide: NFSE_GATEWAY,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => {
    const env = config.get('NFSE_ENV', { infer: true });
    if (env === 'fake') return new FakeNfseGateway();
    throw new Error(`NFSE_ENV=${env} is not wired yet (NationalNfseGateway lands in a later task)`);
  },
};

@Module({
  providers: [CertificateVault, gatewayProvider],
  exports: [CertificateVault, gatewayProvider],
})
export class NfseModule {}
