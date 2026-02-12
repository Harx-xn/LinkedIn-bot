import { prisma } from './src/prismaClient';
import { REDDIT_PRESETS } from './src/config/redditTrendsFeeds';
import { TrendsService } from './src/services/trendsService';
import dotenv from 'dotenv';
dotenv.config();

async function setupAndTestReddit() {
    console.log('🤖 Setting up Reddit Trends...\n');

    const trendsService = new TrendsService();
    const testUrl = REDDIT_PRESETS.ALL[0];

    console.log(`📡 Testing fetch from: ${testUrl}`);
    try {
        const trends = await trendsService.fetchRedditJsonTrends(testUrl);
        console.log(`✅ Success! Found ${trends.length} trends.`);
        trends.slice(0, 3).forEach((t, i) => console.log(`   ${i + 1}. ${t.title} [${t.source}]`));
    } catch (e: any) {
        console.error(`❌ Test failed: ${e.message}`);
    }

    try {
        const user = await prisma.user.findFirst();
        if (!user) return console.log('❌ No user found');

        await prisma.botConfig.update({
            where: { userId: user.id },
            data: {
                // @ts-ignore
                customRedditFeeds: JSON.stringify(REDDIT_PRESETS.ALL)
            }
        });
        console.log('\n✅ Updated Bot Config with Reddit feeds.');
    } catch (e: any) {
        console.error(`\n❌ DB Update failed: ${e.message}`);
    } finally {
        await prisma.$disconnect();
    }
}

setupAndTestReddit();
