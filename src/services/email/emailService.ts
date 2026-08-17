import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { buildSubscriptionEmail, type SubscriptionEmailEventType, type SubscriptionEmailTemplateData } from './subscriptionEmailTemplates';

let transporter: Transporter | null = null;

function smtpConfig() {
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = (process.env.SMTP_SECURE ?? 'true').toLowerCase() === 'true';
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  const fromEmail = process.env.SMTP_FROM_EMAIL?.trim();
  if (!host || !user || !pass || !fromEmail || !Number.isInteger(port)) {
    throw new Error('SMTP configuration is incomplete');
  }
  const authenticatedDomain = user.split('@')[1]?.toLowerCase();
  const senderDomain = fromEmail.split('@')[1]?.toLowerCase();
  if (!authenticatedDomain || !senderDomain || authenticatedDomain !== senderDomain) {
    throw new Error('SMTP_FROM_EMAIL must use the same domain as the authenticated SMTP_USER');
  }
  return { host, port, secure, user, pass, fromEmail, fromName: process.env.SMTP_FROM_NAME?.trim() || 'Veyrais' };
}

export function getEmailTransporter() {
  if (!transporter) {
    const config = smtpConfig();
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
    });
  }
  return transporter;
}

export async function verifyEmailTransporter() {
  await getEmailTransporter().verify();
}

export async function sendSubscriptionEmail(params: {
  eventType: SubscriptionEmailEventType;
  to: string;
  data: SubscriptionEmailTemplateData;
}) {
  const config = smtpConfig();
  const content = buildSubscriptionEmail(params.eventType, { ...params.data, appUrl: params.data.appUrl ?? process.env.APP_URL });
  const result = await getEmailTransporter().sendMail({
    from: { name: config.fromName, address: config.fromEmail },
    to: params.to,
    ...content,
  });
  return { messageId: result.messageId || null };
}
