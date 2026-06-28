import { GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { R2_BUCKET_NAME, R2_PUBLIC_URL, r2 } from '../middleware/r2';

export type BrandLogoPosition = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

const VALID_POSITIONS = new Set<BrandLogoPosition>([
  'topLeft', 'topRight', 'bottomLeft', 'bottomRight',
]);

export function normalizeBrandLogoPosition(value: unknown): BrandLogoPosition {
  return VALID_POSITIONS.has(value as BrandLogoPosition)
    ? (value as BrandLogoPosition)
    : 'bottomRight';
}

export function getOwnedBrandLogoKey(url: unknown, userId: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const publicBase = R2_PUBLIC_URL.replace(/\/$/, '');
  const prefix = `${publicBase}/uploads/brand-logos/${userId}/`;
  return url.trim().startsWith(prefix) ? url.trim().slice(publicBase.length + 1) : null;
}

export async function applyBrandLogoWatermark(input: {
  baseImage: Buffer;
  logoUrl: string;
  userId: string;
  position: BrandLogoPosition;
}): Promise<Buffer> {
  const key = getOwnedBrandLogoKey(input.logoUrl, input.userId);
  if (!key) throw new Error('Brand logo is not owned by this user');

  const object = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  if (!object.Body) throw new Error('Brand logo file is empty');
  const logoSource = Buffer.from(await object.Body.transformToByteArray());
  const metadata = await sharp(input.baseImage).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Generated image dimensions unavailable');

  const logoWidth = Math.max(24, Math.round(metadata.width * 0.06));
  const margin = Math.max(16, Math.round(metadata.width * 0.04));
  const logo = await sharp(logoSource)
    .resize({ width: logoWidth, withoutEnlargement: true })
    .ensureAlpha(0.9)
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = input.position.endsWith('Right')
    ? metadata.width - logo.info.width - margin
    : margin;
  const top = input.position.startsWith('bottom')
    ? metadata.height - logo.info.height - margin
    : margin;

  return sharp(input.baseImage)
    .composite([{ input: logo.data, left: Math.max(0, left), top: Math.max(0, top) }])
    .toBuffer();
}
