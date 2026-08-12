import { Safepay } from '@sfpy/node-sdk';
import { prisma } from '../../../../prismaClient';
import { decryptSecret } from '../../../secretCrypto';
import { BillingError } from '../../billingError';

export type SafepayEnvironment = 'SANDBOX' | 'LIVE';

export async function loadSafepayConfiguration(regionId: string) {
  const config = await prisma.paymentConfig.findUnique({ where: { regionId } });
  const publicKey = decryptSecret(config?.safepayPublicKey);
  const secretKey = decryptSecret(config?.safepaySecretKey);
  const webhookSecret = decryptSecret(config?.safepayWebhookSecret);
  const environment = (config?.safepayEnvironment ?? 'SANDBOX') as SafepayEnvironment;

  if (!config?.isActive || !publicKey || !secretKey || !webhookSecret || !['SANDBOX', 'LIVE'].includes(environment)) {
    throw new BillingError(400, 'BILLING_NOT_AVAILABLE', 'Payment provider is not configured for this region yet.');
  }
  return { publicKey, secretKey, webhookSecret, environment };
}

export async function getSafepayClient(regionId: string) {
  const config = await loadSafepayConfiguration(regionId);
  return {
    config,
    client: new Safepay({
      environment: (config.environment === 'SANDBOX' ? 'sandbox' : 'production') as any,
      apiKey: config.publicKey,
      v1Secret: config.secretKey,
      webhookSecret: config.webhookSecret,
    }),
  };
}
