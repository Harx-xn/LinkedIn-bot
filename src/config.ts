import dotenv from 'dotenv';
dotenv.config();

const DEFAULT_JWT_SECRET = 'change-me';
const jwtSecret = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;

// Fail fast in production if the secret was never configured; in development we
// only warn so local setup stays frictionless.
if (jwtSecret === DEFAULT_JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('[config] JWT_SECRET is not set — using an insecure default (dev only).');
}

export const config = {
  port: process.env.PORT || 4000,

  // Single source of truth for JWT signing/verification (used by all auth paths).
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  googleAuth: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_AUTH_REDIRECT_URI || '',
  },
  linkedinAuth: {
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
    redirectUri: process.env.LINKEDIN_AUTH_REDIRECT_URI || '',
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
    redirectUri: process.env.LINKEDIN_REDIRECT_URI || '',
    apiVersion: process.env.LINKEDIN_API_VERSION || '202511'
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || ''
  }
};
