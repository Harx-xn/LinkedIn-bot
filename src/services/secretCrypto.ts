import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error('SECRETS_ENCRYPTION_KEY is missing');
  }

  const key = Buffer.from(raw, 'base64');

  if (key.length !== 32) {
    throw new Error('SECRETS_ENCRYPTION_KEY must be a 32-byte base64 value');
  }

  return key;
}

export function encryptSecret(value?: string | null): string | null {
  if (!value) return null;

  // Prevent double encryption if an encrypted value accidentally gets passed in.
  if (value.startsWith(PREFIX)) return value;

  const key = getKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptSecret(value?: string | null): string | null {
  if (!value) return null;

  // Temporary backwards compatibility for existing plaintext rows.
  // This lets the app keep working until you run a migration script.
  if (!value.startsWith(PREFIX)) return value;

  const [, ivB64, authTagB64, encryptedB64] = value.split('.');

  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error('Invalid encrypted secret format');
  }

  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export function encryptSecretArray(values?: string[] | null): string | null {
  if (!values || values.length === 0) return null;

  return JSON.stringify(values.map((value) => encryptSecret(value)).filter(Boolean));
}

export function decryptSecretArray(value?: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => decryptSecret(String(item)))
      .filter(Boolean) as string[];
  } catch {
    return [];
  }
}