import { Safepay } from '@sfpy/node-sdk';
import axios from 'axios';
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

  if (!config?.isActive || config.provider !== 'SAFEPAY' || !publicKey || !secretKey || !webhookSecret || !['SANDBOX', 'LIVE'].includes(environment)) {
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

export async function retrieveSafepaySubscription(regionId: string, subscriptionId: string) {
  const providerConfig = await loadSafepayConfiguration(regionId);
  const baseUrl = providerConfig.environment === 'SANDBOX'
    ? 'https://sandbox.api.getsafepay.com'
    : 'https://api.getsafepay.com';
  try {
    console.info('[SAFEPAY-PROVIDER-SUBSCRIPTION-FETCH]', {
      regionId,
      providerSubscriptionId: subscriptionId,
      environment: providerConfig.environment,
      apiBaseUrl: baseUrl,
    });
    const response = await axios.get(
      `${baseUrl}/client/subscriptions/v1/${encodeURIComponent(subscriptionId)}`,
      { headers: { 'X-SFPY-MERCHANT-SECRET': providerConfig.secretKey } },
    );
    const envelope = response.data?.data;
    const subscription = envelope?.subscription ?? envelope;
    if (!subscription || typeof subscription !== 'object') throw new Error('Safepay returned an invalid subscription response');
    console.info('[SAFEPAY-PROVIDER-SUBSCRIPTION-RESULT]', {
      regionId,
      providerSubscriptionId: String(subscription.token ?? subscription.id ?? subscriptionId),
      planId: subscription.plan_id ? String(subscription.plan_id) : null,
      providerStatus: subscription.status ? String(subscription.status) : null,
      httpStatus: response.status,
    });
    return subscription as Record<string, any>;
  } catch (error) {
    const httpStatus = axios.isAxiosError(error) ? error.response?.status ?? null : null;
    console.error('[SAFEPAY-PROVIDER-SUBSCRIPTION-RESULT]', {
      regionId,
      providerSubscriptionId: subscriptionId,
      environment: providerConfig.environment,
      apiBaseUrl: baseUrl,
      httpStatus,
      outcome: 'error',
    });
    throw new Error(`Unable to fetch Safepay subscription${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
