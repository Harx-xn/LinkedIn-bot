import { prisma } from './src/prismaClient';
import { GOOGLE_TRENDS_FEEDS } from './src/config/googleTrendsFeeds';
import { REDDIT_PRESETS } from './src/config/redditTrendsFeeds';
import { MEDIUM_PRESETS } from './src/config/mediumTrendsFeeds';
import { LINKEDIN_PRESETS } from './src/config/linkedinTrendsFeeds';
import { TrendsService } from './src/services/trendsService';
import dotenv from 'dotenv';
dotenv.config();

async function setupAllTrends() {
    console.log('🌟 COMPREHENSIVE TRENDS SETUP 🌟\n');

    try {
        const user = await prisma.user.findFirst();
        if (!user) {
            console.log('❌ No user found.');
            return;
        }

        console.log(`Setting up trends for: ${user.email}\n`);

        // 1. COMBINE RSS FEEDS (Google + Medium)
        const customRssFeeds = [
            ...Object.values(GOOGLE_TRENDS_FEEDS),
            ...MEDIUM_PRESETS.ALL
        ];

        // 2. REDDIT FEEDS
        const customRedditFeeds = REDDIT_PRESETS.ALL;

        // 3. CUSTOM LINKS (LinkedIn)
        const customLinks = LINKEDIN_PRESETS.ALL;

        console.log('--- Summary of Sources ---');
        console.log(`RSS Feeds: ${customRssFeeds.length} (Google Trends + Medium Tags)`);
        console.log(`Reddit: ${customRedditFeeds.length} (r/all + r/popular)`);
        console.log(`Links: ${customLinks.length} (LinkedIn Hashtags)`);

        await prisma.botConfig.update({
            where: { userId: user.id },
            data: {
                // @ts-ignore
                customRssFeeds: JSON.stringify(customRssFeeds),
                // @ts-ignore
                customRedditFeeds: JSON.stringify(customRedditFeeds),
                // @ts-ignore
                customLinks: JSON.stringify(customLinks),
            }
        });

        console.log('\n✅ Database updated successfully.');

        // 4. TEST FETCHING
        console.log('\n--- Quick Test Fetch ---');
        const trendsService = new TrendsService();

        // Test a Medium feed
        console.log('📡 Testing Medium feed...');
        const mediumTrends = await trendsService.fetchCustomRssTrends(MEDIUM_PRESETS.ALL[0]);
        console.log(`   Found ${mediumTrends.length} Medium trends.`);

        // Test a LinkedIn link
        console.log('📡 Testing LinkedIn link...');
        const linkedInTrends = await trendsService.fetchCustomTrends([LINKEDIN_PRESETS.ALL[0]]);
        console.log(`   Processed LinkedIn link: ${linkedInTrends[0].title} [${linkedInTrends[0].source}]`);

        console.log('\n✨ All sources are ready! Your bot is now a powerhouse of trends.');

    } catch (error) {
        console.error('❌ Setup failed:', error);
    } finally {
        await prisma.$disconnect();
    }
}

setupAllTrends();
