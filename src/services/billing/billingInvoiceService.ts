import { prisma } from '../../prismaClient';
import { BillingError } from './billingError';
import { getRegionalStripeClient, isStripeConfigured } from './stripeClientService';

export type BillingInvoiceStatus =
  | 'paid'
  | 'open'
  | 'void'
  | 'draft'
  | 'uncollectible';

export interface BillingInvoiceDto {
  id: string;
  number: string | null;
  status: BillingInvoiceStatus;
  amountDue: number;
  amountPaid: number;
  currency: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

interface StripeInvoiceLike {
  id: string;
  number?: string | null;
  status?: string | null;
  amount_due?: number | null;
  amount_paid?: number | null;
  currency?: string | null;
  created?: number | null;
  period_start?: number | null;
  period_end?: number | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
}

function stripeTs(seconds: number | null | undefined): string | null {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizeInvoiceStatus(status: string | null | undefined): BillingInvoiceStatus {
  const allowed: BillingInvoiceStatus[] = [
    'paid',
    'open',
    'void',
    'draft',
    'uncollectible',
  ];
  if (status && allowed.includes(status as BillingInvoiceStatus)) {
    return status as BillingInvoiceStatus;
  }
  return 'open';
}

export function normalizeStripeInvoice(invoice: StripeInvoiceLike): BillingInvoiceDto {
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    status: normalizeInvoiceStatus(invoice.status),
    amountDue: invoice.amount_due ?? 0,
    amountPaid: invoice.amount_paid ?? 0,
    currency: (invoice.currency ?? 'usd').toLowerCase(),
    createdAt: stripeTs(invoice.created) ?? new Date(0).toISOString(),
    periodStart: stripeTs(invoice.period_start),
    periodEnd: stripeTs(invoice.period_end),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
  };
}

export async function getBillingInvoices(userId: string): Promise<{ invoices: BillingInvoiceDto[] }> {
  const [sub, user] = await Promise.all([
    prisma.subscription.findFirst({
      where: {
        userId,
        OR: [
          { stripeSubscriptionId: { not: null } },
          { stripeCustomerId: { not: null } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { regionId: true, stripeCustomerId: true },
    }),
  ]);

  const regionId = sub?.regionId ?? user?.regionId ?? null;
  const stripeCustomerId = sub?.stripeCustomerId ?? user?.stripeCustomerId ?? null;
  const stripeSubscriptionId = sub?.stripeSubscriptionId ?? null;

  if (!regionId || (!stripeCustomerId && !stripeSubscriptionId)) {
    return { invoices: [] };
  }

  const configured = await isStripeConfigured(regionId);
  if (!configured) {
    return { invoices: [] };
  }

  try {
    const stripe = await getRegionalStripeClient(regionId);
    const result = stripeCustomerId
      ? await stripe.invoices.list({ customer: stripeCustomerId, limit: 20 })
      : await stripe.invoices.list({ subscription: stripeSubscriptionId!, limit: 20 });

    return {
      invoices: result.data.map((invoice) =>
        normalizeStripeInvoice(invoice as StripeInvoiceLike),
      ),
    };
  } catch (err) {
    if (err instanceof BillingError) throw err;
    throw new BillingError(502, 'INVOICES_FETCH_FAILED', 'Could not load invoices.');
  }
}
