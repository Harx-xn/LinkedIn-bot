"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLinkedInAuthUrl = getLinkedInAuthUrl;
exports.exchangeCodeForToken = exchangeCodeForToken;
exports.saveLinkedInAccountForUser = saveLinkedInAccountForUser;
exports.postToLinkedInFromPostId = postToLinkedInFromPostId;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const prismaClient_1 = require("../prismaClient");
const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const scopes = [
    'openid',
    'profile',
    'email',
    'w_member_social'
];
function getLinkedInAuthUrl(clientId, state) {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: config_1.config.linkedin.redirectUri,
        scope: scopes.join(' '),
        state
    });
    return `${LINKEDIN_AUTH_URL}?${params.toString()}`;
}
async function exchangeCodeForToken(clientId, clientSecret, code) {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config_1.config.linkedin.redirectUri,
        client_id: clientId,
        client_secret: clientSecret
    });
    const { data } = await axios_1.default.post(LINKEDIN_TOKEN_URL, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in
    };
}
async function getMemberUrn(accessToken) {
    const { data } = await axios_1.default.get('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const memberId = data.sub;
    return `urn:li:person:${memberId}`;
}
async function saveLinkedInAccountForUser(userId, accessToken, expiresIn) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);
    const authorUrn = await getMemberUrn(accessToken);
    const existing = await prismaClient_1.prisma.linkedInAccount.findFirst({ where: { userId } });
    if (existing) {
        return prismaClient_1.prisma.linkedInAccount.update({
            where: { id: existing.id },
            data: { accessToken, expiresAt, authorUrn }
        });
    }
    return prismaClient_1.prisma.linkedInAccount.create({
        data: {
            userId,
            accessToken,
            expiresAt,
            authorUrn
        }
    });
}
async function postToLinkedInFromPostId(postId) {
    const post = await prismaClient_1.prisma.post.findUnique({
        where: { id: postId },
        include: { user: true, linkedinAccount: true }
    });
    if (!post)
        throw new Error('Post not found');
    if (!post.linkedinAccountId || !post.linkedinAccount)
        throw new Error('No LinkedIn account attached');
    const liAccount = post.linkedinAccount;
    const accessToken = liAccount.accessToken;
    const body = {
        author: liAccount.authorUrn,
        commentary: post.content,
        visibility: 'PUBLIC',
        distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: []
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false
    };
    const response = await axios_1.default.post('https://api.linkedin.com/rest/posts', body, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'Linkedin-Version': config_1.config.linkedin.apiVersion
        }
    });
    const urn = response.headers['x-restli-id'];
    await prismaClient_1.prisma.post.update({
        where: { id: post.id },
        data: {
            status: 'PUBLISHED',
            publishedAt: new Date(),
            linkedinPostUrn: urn ?? null
        }
    });
    return { urn, data: response.data };
}
