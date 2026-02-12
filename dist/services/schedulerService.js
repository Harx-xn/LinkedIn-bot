"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startScheduler = startScheduler;
const node_cron_1 = __importDefault(require("node-cron"));
const prismaClient_1 = require("../prismaClient");
const linkedinService_1 = require("./linkedinService");
const sheetsService_1 = require("./sheetsService");
function startScheduler() {
    // Sync Sheets every 10 minutes
    node_cron_1.default.schedule('*/10 * * * *', async () => {
        console.log('Running Sheet Sync...');
        const configs = await prismaClient_1.prisma.sheetConfig.findMany({
            where: { active: true },
            include: { user: true }
        });
        for (const config of configs) {
            if (!config.accessToken || !config.user.googleClientId || !config.user.googleClientSecret)
                continue;
            try {
                // NOTE: In production, handle token refresh if expired using refreshToken
                const rows = await (0, sheetsService_1.fetchPostsFromSheet)(config.user.googleClientId, config.user.googleClientSecret, config.spreadsheetId, config.range, config.accessToken);
                for (const row of rows) {
                    // Basic duplicplication check: if content exists for user, skip
                    // Ideally, add a specific ID column in Sheet
                    if (!row.content)
                        continue;
                    const duplicate = await prismaClient_1.prisma.post.findFirst({
                        where: {
                            userId: config.userId,
                            content: row.content,
                            source: 'GOOGLE_SHEET'
                        }
                    });
                    if (!duplicate) {
                        await prismaClient_1.prisma.post.create({
                            data: {
                                userId: config.userId,
                                content: row.content,
                                hashtags: row.hashtags,
                                source: 'GOOGLE_SHEET',
                                status: 'DRAFT', // or QUEUED if date/time is parsed
                                // Parsing date/time is complex, skipping for this basic version
                            }
                        });
                        console.log('Imported post from sheet for user', config.userId);
                    }
                }
            }
            catch (err) {
                console.error('Sheet sync failed for config', config.id, err?.message);
            }
        }
    });
    node_cron_1.default.schedule('* * * * *', async () => {
        const now = new Date();
        const duePosts = await prismaClient_1.prisma.post.findMany({
            where: {
                status: 'QUEUED',
                scheduledAt: { lte: now }
            },
            take: 10
        });
        for (const post of duePosts) {
            try {
                await (0, linkedinService_1.postToLinkedInFromPostId)(post.id);
                console.log('Published post', post.id);
            }
            catch (err) {
                console.error('Failed to publish post', post.id, err?.message || err);
                await prismaClient_1.prisma.post.update({
                    where: { id: post.id },
                    data: {
                        status: 'FAILED',
                        errorMessage: err?.message || 'Unknown error'
                    }
                });
            }
        }
    });
}
