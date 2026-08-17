export interface SubscriptionEmailTemplateData {
  recipientName?: string | null;
  planName: string;
  amount?: number | null;
  currency?: string | null;
  billingCycle?: string | null;
  trialEndsAt?: Date | null;
  nextBillingAt?: Date | null;
  appUrl?: string | null;
}

export type SubscriptionEmailEventType = 'SUBSCRIPTION_CONFIRMED' | 'TRIAL_STARTED';

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] as string);
}

function dateLabel(value?: Date | null) {
  return value ? new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(value) : null;
}

function priceLabel(data: SubscriptionEmailTemplateData) {
  if (data.amount == null || !data.currency) return null;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: data.currency.toUpperCase() }).format(data.amount);
  } catch {
    return `${data.amount} ${data.currency.toUpperCase()}`;
  }
}

export function buildSubscriptionEmail(
  eventType: SubscriptionEmailEventType,
  data: SubscriptionEmailTemplateData,
) {
  const greeting = data.recipientName?.trim() ? `Hi ${data.recipientName.trim()},` : 'Hi,';
  const plan = data.planName || 'your Veyrais plan';
  const price = priceLabel(data);
  const trialEnd = dateLabel(data.trialEndsAt);
  const nextBilling = dateLabel(data.nextBillingAt);
  const appUrl = data.appUrl?.trim() || null;
  const isTrial = eventType === 'TRIAL_STARTED';
  const subject = isTrial ? `Your ${plan} trial has started` : `Your ${plan} subscription is confirmed`;
  const headline = isTrial ? 'Your Veyrais trial has started' : 'Your Veyrais subscription is active';
  const intro = isTrial
    ? `You now have trial access to the ${plan} plan.`
    : `Your subscription to the ${plan} plan has been confirmed.`;
  const details = [
    `Plan: ${plan}`,
    price ? `Price: ${price}${data.billingCycle ? ` / ${data.billingCycle}` : ''}` : null,
    isTrial && trialEnd ? `Trial ends: ${trialEnd}` : null,
    !isTrial && nextBilling ? `Next billing date: ${nextBilling}` : null,
  ].filter((value): value is string => Boolean(value));
  const text = [greeting, '', intro, '', ...details, appUrl ? '' : null, appUrl ? `Open Veyrais: ${appUrl}` : null, '', '— The Veyrais team']
    .filter((value): value is string => value !== null).join('\n');
  const detailHtml = details.map((detail) => `<li style="margin:6px 0">${escapeHtml(detail)}</li>`).join('');
  const button = appUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(appUrl)}" style="background:#111827;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Open Veyrais</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827"><div style="max-width:600px;margin:0 auto;padding:32px 16px"><div style="background:#fff;border-radius:12px;padding:32px"><p>${escapeHtml(greeting)}</p><h1 style="font-size:24px">${escapeHtml(headline)}</h1><p>${escapeHtml(intro)}</p><ul style="padding-left:20px">${detailHtml}</ul>${button}<p style="color:#6b7280;margin-top:32px">— The Veyrais team</p></div></div></body></html>`;
  return { subject, text, html };
}
