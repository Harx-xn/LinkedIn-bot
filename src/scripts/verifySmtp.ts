import 'dotenv/config';
import { verifyEmailTransporter } from '../services/email/emailService';

async function main() {
  await verifyEmailTransporter();
  console.info('[SMTP_VERIFY_SUCCESS]', {
    host: process.env.SMTP_HOST?.trim() || null,
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE ?? 'true').toLowerCase() === 'true',
    userConfigured: Boolean(process.env.SMTP_USER?.trim()),
    fromConfigured: Boolean(process.env.SMTP_FROM_EMAIL?.trim()),
  });
}

main().catch((error) => {
  console.error('[SMTP_VERIFY_FAILED]', {
    message: error instanceof Error ? error.message : 'SMTP verification failed',
  });
  process.exitCode = 1;
});
