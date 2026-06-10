import axios from 'axios';
import { config } from '../config';
import { prisma } from '../prismaClient';
import { decryptSecret } from './secretCrypto';

const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

// Base scopes are always requested and are covered by LinkedIn's default
// "Sign In with LinkedIn" + "Share on LinkedIn" products.
const BASE_SCOPES = [
  'openid',
  'profile',
  'email',
  'w_member_social'
];

// Real post-analytics scopes. These belong to LinkedIn's Community Management
// API product and ONLY work once your app has been approved for it. Requesting
// them before approval makes LinkedIn reject the entire OAuth request, so they
// are gated behind LINKEDIN_ENABLE_ANALYTICS_SCOPES. Flip that env var to
// "true" after approval, then have users re-connect to grant the new scopes.
const ANALYTICS_SCOPES = [
  'r_member_postAnalytics',   // member post stats (impressions/reach/engagement), API >= 202506
  'r_organization_social'     // organization page share statistics
];

export function getLinkedInScopes(): string[] {
  return process.env.LINKEDIN_ENABLE_ANALYTICS_SCOPES === 'true'
    ? [...BASE_SCOPES, ...ANALYTICS_SCOPES]
    : [...BASE_SCOPES];
}

export function getLinkedInAuthUrl(clientId: string, state: string, redirectUri?: string) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri || config.linkedin.redirectUri,
    scope: getLinkedInScopes().join(' '),
    state
  });

  return `${LINKEDIN_AUTH_URL}?${params.toString()}`;
}

// Resolve the LinkedIn app credentials for a user, preferring their region's
// values and falling back to the platform-wide env config.
export async function getRegionLinkedInCreds(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      region: {
        select: {
          linkedinClientId: true,
          linkedinClientSecret: true,
          linkedinRedirectUri: true,
          linkedinApiVersion: true,
        },
      },
    },
  });
  const r = user?.region;
  const regionClientSecret = decryptSecret(r?.linkedinClientSecret);

  return {
    clientId: r?.linkedinClientId || process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: regionClientSecret || process.env.LINKEDIN_CLIENT_SECRET || '',
    redirectUri: r?.linkedinRedirectUri || config.linkedin.redirectUri,
    apiVersion: r?.linkedinApiVersion || config.linkedin.apiVersion,
  };
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri?: string
) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || config.linkedin.redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  });

  const { data } = await axios.post(
    LINKEDIN_TOKEN_URL,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return {
    accessToken: data.access_token as string,
    expiresIn: data.expires_in as number
  };
}

async function getMemberUrn(accessToken: string): Promise<string> {
  const { data } = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const memberId = data.sub;
  return `urn:li:person:${memberId}`;
}

export async function saveLinkedInAccountForUser(userId: string, accessToken: string, expiresIn: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  const authorUrn = await getMemberUrn(accessToken);

  const existing = await prisma.linkedInAccount.findFirst({ where: { userId } });
  if (existing) {
    return prisma.linkedInAccount.update({
      where: { id: existing.id },
      data: { accessToken, expiresAt, authorUrn }
    });
  }
  return prisma.linkedInAccount.create({
    data: {
      userId,
      accessToken,
      expiresAt,
      authorUrn
    }
  });
}

async function uploadImageToLinkedIn(
  accessToken: string,
  authorUrn: string,
  imagePath: string,
  apiVersion: string = config.linkedin.apiVersion
): Promise<string> {
  const fs = require("fs");
  const path = require("path");

  // Step 1: Register upload
  const registerResponse = await axios.post(
    "https://api.linkedin.com/rest/images?action=initializeUpload",
    {
      initializeUploadRequest: {
        owner: authorUrn,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": apiVersion,
      },
    }
  );

  const uploadUrl = registerResponse.data.value.uploadUrl;
  const imageUrn = registerResponse.data.value.image;

  let imageBuffer: Buffer;

  // New R2/public URL support
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    console.log(`Downloading image from URL: ${imagePath}`);

    const imageResponse = await axios.get(imagePath, {
      responseType: "arraybuffer",
    });

    imageBuffer = Buffer.from(imageResponse.data);
  } else {
    // Backward compatibility for old local images
    const UPLOAD_DIR = process.env.RENDER
      ? "/opt/render/project/src/uploads"
      : path.join(process.cwd(), "uploads");

    const fullPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(UPLOAD_DIR, imagePath);

    if (!fs.existsSync(fullPath)) {
      console.error(`Image file not found at path: ${fullPath}`);
      throw new Error(`Image file not found: ${fullPath}`);
    }

    console.log(`Uploading image from local path: ${fullPath}`);
    imageBuffer = fs.readFileSync(fullPath);
  }

  // Step 2: Upload image binary to LinkedIn
  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return imageUrn;
}

export async function postToLinkedInFromPostId(postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: { user: true, linkedinAccount: true }
  });
  if (!post) throw new Error('Post not found');
  if (!post.linkedinAccountId || !post.linkedinAccount) throw new Error('No LinkedIn account attached');

  const liAccount = post.linkedinAccount;
  const accessToken = liAccount.accessToken;

  // Resolve the region's LinkedIn API version (falls back to env/global).
  const creds = await getRegionLinkedInCreds(post.userId);
  const apiVersion = creds.apiVersion;

  // Use organization URN if selected, otherwise use personal URN
  const authorUrn = liAccount.selectedOrganizationUrn || liAccount.authorUrn;

  const body: any = {
    author: authorUrn,
    commentary: post.content.replace(/\n{3,}/g, '\n\n'),
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };

  // If post has an image, upload it and attach
  if (post.mediaUrl) {
    try {
      const imageUrn = await uploadImageToLinkedIn(accessToken, authorUrn, post.mediaUrl, apiVersion);
      body.content = {
        media: {
          id: imageUrn
        }
      };
    } catch (error) {
      console.error('Failed to upload image to LinkedIn:', error);
      // Continue posting without image
    }
  }

  const response = await axios.post(
    'https://api.linkedin.com/rest/posts',
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': apiVersion
      }
    }
  );

  const urn = response.headers['x-restli-id'] as string | undefined;

  const publishedAt = new Date();
  await prisma.post.update({
    where: { id: post.id },
    data: {
      status: 'PUBLISHED',
      publishedAt,
      linkedinPostUrn: urn ?? null
    }
  });

  try {
    const { safeUpdateTopicHistoryStatus } = await import('./topicHistoryService');
    await safeUpdateTopicHistoryStatus(post.id, 'PUBLISHED', publishedAt);
  } catch (err) {
    console.warn('[topic-history] publish status update failed', {
      postId: post.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { urn, data: response.data };
}
