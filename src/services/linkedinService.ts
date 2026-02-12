import axios from 'axios';
import { config } from '../config';
import { prisma } from '../prismaClient';

const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

const scopes = [
  'openid',
  'profile',
  'email',
  'w_member_social'
];

export function getLinkedInAuthUrl(clientId: string, state: string) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: config.linkedin.redirectUri,
    scope: scopes.join(' '),
    state
  });

  return `${LINKEDIN_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(clientId: string, clientSecret: string, code: string) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.linkedin.redirectUri,
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

async function uploadImageToLinkedIn(accessToken: string, authorUrn: string, imagePath: string): Promise<string> {
  const fs = require('fs');
  const path = require('path');

  // Step 1: Register upload
  const registerResponse = await axios.post(
    'https://api.linkedin.com/rest/images?action=initializeUpload',
    {
      initializeUploadRequest: {
        owner: authorUrn
      }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': config.linkedin.apiVersion
      }
    }
  );

  const uploadUrl = registerResponse.data.value.uploadUrl;
  const imageUrn = registerResponse.data.value.image;

  // Step 2: Upload the image binary
  // imagePath is already an absolute path from imageService
  const fullPath = path.isAbsolute(imagePath) ? imagePath : path.join(process.cwd(), 'dist/public', imagePath);

  if (!fs.existsSync(fullPath)) {
    console.error(`Image file not found at path: ${fullPath}`);
    throw new Error(`Image file not found: ${fullPath}`);
  }

  console.log(`Uploading image from: ${fullPath}`);
  const imageBuffer = fs.readFileSync(fullPath);

  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${accessToken}`
    }
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
      const imageUrn = await uploadImageToLinkedIn(accessToken, authorUrn, post.mediaUrl);
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
        'LinkedIn-Version': config.linkedin.apiVersion
      }
    }
  );

  const urn = response.headers['x-restli-id'] as string | undefined;

  await prisma.post.update({
    where: { id: post.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      linkedinPostUrn: urn ?? null
    }
  });

  return { urn, data: response.data };
}
