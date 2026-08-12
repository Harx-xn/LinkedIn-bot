import { prisma } from '../../../../prismaClient';
import { BillingError } from '../../billingError';
import type { SafepayEnvironment } from './safepayClient';

export async function resolveSafepayPlanMapping(planId: string, regionId: string, environment: SafepayEnvironment) {
  const plan = await prisma.plan.findFirst({ where: { id: planId, regionId, isActive: true } });
  if (!plan) throw new BillingError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  const mapping = await prisma.planProviderMapping.findUnique({
    where: { planId_provider_environment: { planId, provider: 'SAFEPAY', environment } },
  });
  if (!mapping?.providerPlanId) {
    throw new BillingError(400, 'PLAN_NOT_ACTIVE', 'This plan is not configured for online billing yet.');
  }
  return { plan, mapping };
}

