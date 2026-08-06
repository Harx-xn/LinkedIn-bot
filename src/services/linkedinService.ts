import axios from 'axios';
import { config } from '../config';
import { prisma } from '../prismaClient';
import { decryptSecret } from './secretCrypto';
import { updateGoogleSheetPostStatus } from './sheetsService';
import { prepareLinkedInCommentary } from './linkedinPublishingText';

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

type LinkedInUserInfo = {
  memberId: string;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  picture: string | null;
};

function optionalUserInfoString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function getLinkedInUserInfo(accessToken: string): Promise<LinkedInUserInfo> {
  const { data } = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const memberId = optionalUserInfoString(data.sub);
  if (!memberId) throw new Error('LinkedIn userinfo response did not include a member ID');

  const givenName = optionalUserInfoString(data.given_name);
  const familyName = optionalUserInfoString(data.family_name);
  const fallbackName = [givenName, familyName].filter(Boolean).join(' ') || null;

  return {
    memberId,
    name: optionalUserInfoString(data.name) ?? fallbackName,
    givenName,
    familyName,
    email: optionalUserInfoString(data.email),
    picture: optionalUserInfoString(data.picture),
  };
}

export async function saveLinkedInAccountForUser(userId: string, accessToken: string, expiresIn: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  const profile = await getLinkedInUserInfo(accessToken);
  const authorUrn = `urn:li:person:${profile.memberId}`;
  const profileData = {
    linkedInMemberId: profile.memberId,
    profileName: profile.name,
    profileEmail: profile.email,
    profileImageUrl: profile.picture,
  };

  const existing = await prisma.linkedInAccount.findFirst({ where: { userId } });
  if (existing) {
    const account = await prisma.linkedInAccount.update({
      where: { id: existing.id },
      data: { accessToken, expiresAt, authorUrn, ...profileData }
    });
    await repairGoogleSheetPostsAfterLinkedInConnect(userId, account.id);
    return account;
  }
  const account = await prisma.linkedInAccount.create({
    data: {
      userId,
      accessToken,
      expiresAt,
      authorUrn,
      ...profileData,
    }
  });
  await repairGoogleSheetPostsAfterLinkedInConnect(userId, account.id);
  return account;
}

export function isLinkedInAccountUsable(
  account?: { accessToken?: string | null; expiresAt?: Date | null } | null,
  now: Date = new Date(),
) {
  return Boolean(
    account?.accessToken?.trim() &&
      account.expiresAt &&
      account.expiresAt.getTime() > now.getTime(),
  );
}

export async function getUsableLinkedInAccountForUser(userId: string) {
  const account = await prisma.linkedInAccount.findFirst({
    where: {
      userId,
      accessToken: { not: "" },
      expiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: "desc" },
  });

  return account && isLinkedInAccountUsable(account) ? account : null;
}

const LINKEDIN_CONNECTION_ERROR_PATTERN =
  /no linkedin account (?:connected|attached)|linkedin account not connected/i;

export async function repairGoogleSheetPostsAfterLinkedInConnect(
  userId: string,
  linkedinAccountId: string,
) {
  const failedPosts = await prisma.post.findMany({
    where: {
      userId,
      source: "GOOGLE_SHEET",
      status: "FAILED",
      errorMessage: { not: null },
    },
    select: {
      id: true,
      scheduledAt: true,
      errorMessage: true,
    },
  });
  const repairable = failedPosts.filter(post =>
    LINKEDIN_CONNECTION_ERROR_PATTERN.test(post.errorMessage || ""),
  );

  await prisma.$transaction([
    prisma.post.updateMany({
      where: {
        userId,
        source: "GOOGLE_SHEET",
        status: { not: "PUBLISHED" },
      },
      data: { linkedinAccountId },
    }),
    ...repairable.map(post =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          linkedinAccountId,
          status: post.scheduledAt ? "QUEUED" : "DRAFT",
          errorMessage: null,
        },
      }),
    ),
  ]);

  return repairable.length;
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

export async function postToLinkedInFromPostId(
  postId: string,
  publishingOverride?: { content: string; mediaUrl: string | null },
) {
  let post = await prisma.post.findUnique({
    where: { id: postId },
    include: { user: true, linkedinAccount: true }
  });
  if (!post) throw new Error('Post not found');

  let liAccount = post.linkedinAccount;
  if (!isLinkedInAccountUsable(liAccount)) {
    const currentAccount = await getUsableLinkedInAccountForUser(post.userId);
    if (!currentAccount) {
      throw new Error(
        'LinkedIn account not connected or connection expired. Reconnect LinkedIn and try again.',
      );
    }

    await prisma.post.update({
      where: { id: post.id },
      data: { linkedinAccountId: currentAccount.id },
    });
    liAccount = currentAccount;
  }
  const activeLinkedInAccount = liAccount!;
  const accessToken = activeLinkedInAccount.accessToken;

  // Resolve the region's LinkedIn API version (falls back to env/global).
  const creds = await getRegionLinkedInCreds(post.userId);
  const apiVersion = creds.apiVersion;

  // Use organization URN if selected, otherwise use personal URN
  const authorUrn =
    activeLinkedInAccount.selectedOrganizationUrn ||
    activeLinkedInAccount.authorUrn;

  // Manual "Post Now" supplies the editor snapshot explicitly. This avoids a
  // second database read ever publishing the pre-rewrite version of a post.
  const publishingContent = publishingOverride?.content ?? post.content;
  const publishingMediaUrl = publishingOverride?.mediaUrl ?? post.mediaUrl;
  const commentary = prepareLinkedInCommentary(publishingContent);

  console.info('[linkedin-publish] prepared commentary', {
    postId: post.id,
    storedLength: post.content.length,
    submittedLength: publishingContent.length,
    commentaryLength: commentary.length,
    usedEditorSnapshot: Boolean(publishingOverride),
  });

  const body: any = {
    author: authorUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };

  if (post.attachmentType === 'CAROUSEL') {
    if (!post.carouselPdfUrl || post.carouselAttachmentStatus !== 'CURRENT') {
      throw new Error('Carousel attachment is missing or outdated. Update it before publishing.');
    }
    const initialize = await axios.post(
      'https://api.linkedin.com/rest/documents?action=initializeUpload',
      { initializeUploadRequest: { owner: authorUrn } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': apiVersion } },
    );
    const uploadUrl = initialize.data?.value?.uploadUrl;
    const documentUrn = initialize.data?.value?.document;
    if (!uploadUrl || !documentUrn) throw new Error('LinkedIn did not provide a document upload target.');
    const pdfResponse = await axios.get(post.carouselPdfUrl, { responseType: 'arraybuffer' });
    await axios.put(uploadUrl, Buffer.from(pdfResponse.data), { headers: { 'Content-Type': 'application/pdf' } });
    body.content = { media: { id: documentUrn, title: post.carouselFileName || 'LinkedIn carousel' } };
  }

  // If post has an image, upload it and attach
  if (post.attachmentType !== 'CAROUSEL' && publishingMediaUrl) {
    try {
      const imageUrn = await uploadImageToLinkedIn(accessToken, authorUrn, publishingMediaUrl, apiVersion);
      body.content = {
        media: {
          id: imageUrn
        }
      };
    } catch (error) {
      console.error('Failed to upload image to LinkedIn:', error);
      // Preserve the existing image-post fallback behavior.
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

  if (post.source === 'GOOGLE_SHEET') {
    try {
      const sheetConfig = await prisma.sheetConfig.findFirst({
        where: { userId: post.userId, active: true },
      });
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!sheetConfig) throw new Error('No active Google Sheet connection found.');
      if (!clientId || !clientSecret) {
        throw new Error('Google Sheets platform credentials are not configured.');
      }

      await updateGoogleSheetPostStatus({
        clientId,
        clientSecret,
        accessToken: sheetConfig.accessToken,
        refreshToken: sheetConfig.refreshToken,
        spreadsheetId: sheetConfig.spreadsheetId,
        range: sheetConfig.range,
        appPostId: post.id,
        status: 'PUBLISHED',
      });
      await prisma.sheetConfig.update({
        where: { id: sheetConfig.id },
        data: { lastSyncError: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[sheets] published status writeback failed', {
        postId: post.id,
        userId: post.userId,
        message,
      });
      await prisma.sheetConfig.updateMany({
        where: { userId: post.userId },
        data: {
          lastSyncError: `Post published, but its Sheet status could not be updated: ${message}`.slice(0, 500),
        },
      }).catch(() => undefined);
    }
  }

  try {
    const { safeUpdateTopicHistoryStatus } = await import('./topicHistoryService');
    await safeUpdateTopicHistoryStatus(post.id, 'PUBLISHED', publishedAt);
  } catch (err) {
    console.warn('[topic-history] publish status update failed', {
      postId: post.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (post.source === 'MANUAL') {
    try {
      const { scheduleManualPostFingerprintSync } = await import('./manualPost/manualPostFingerprintService');
      scheduleManualPostFingerprintSync(post.id, post.userId);
    } catch (err) {
      console.warn('[manual-fingerprint] publish sync failed', {
        postId: post.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { urn, data: response.data };
}
