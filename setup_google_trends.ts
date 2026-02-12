import { prisma } from './src/prismaClient';
import { FEED_PRESETS } from './src/config/googleTrendsFeeds';
import dotenv from 'dotenv';
dotenv.config();

async function updateBotConfigWithGoogleTrends() {
    console.log('🔧 Updating Bot Config with Google Trends RSS Feeds...\n');

    try {
        // Get the first user (or you can specify a userId)
        const user = await prisma.user.findFirst();

        if (!user) {
            console.log('❌ No user found. Please create a user first.');
            return;
        }

        console.log(`Found user: ${user.email}`);

        // Get current bot config
        let config = await prisma.botConfig.findUnique({
            where: { userId: user.id }
        });

        if (!config) {
            console.log('⚠️  No bot config found. Creating new one...');
            config = await prisma.botConfig.create({
                data: {
                    userId: user.id,
                    niches: JSON.stringify(['Technology', 'AI']),
                    sources: JSON.stringify(['google']),
                    customRssFeeds: JSON.stringify(FEED_PRESETS.ALL),
                    isEnabled: false,
                    postsPerWeek: 7,
                    tone: 'Professional'
                }
            });
            console.log('✅ Created new bot config with ALL Google Trends feeds');
        } else {
            // Update existing config
            const updatedConfig = await prisma.botConfig.update({
                where: { userId: user.id },
                data: {
                    customRssFeeds: JSON.stringify(FEED_PRESETS.ALL)
                }
            });
            console.log('✅ Updated bot config with ALL Google Trends feeds');
        }

        console.log(`\n📊 Current configuration:`);
        console.log(`   User: ${user.email}`);
        console.log(`   Niches: ${config.niches}`);
        console.log(`   Sources: ${config.sources}`);
        console.log(`   Custom RSS Feeds: ${FEED_PRESETS.ALL.length} feeds added`);
        console.log(`   Enabled: ${config.isEnabled}`);

        console.log('\n✅ Done! Your bot will now use Google Trends from:');
        console.log('   • United States');
        console.log('   • Europe (11 countries)');
        console.log('   • Gulf/GCC (6 countries)');
        console.log('\n💡 You can customize which regions to use by editing the preset in the script.');

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// You can change FEED_PRESETS.ALL to:
// - FEED_PRESETS.US_ONLY
// - FEED_PRESETS.EUROPE
// - FEED_PRESETS.GCC
// - FEED_PRESETS.US_AND_EUROPE
// - FEED_PRESETS.US_AND_GCC

updateBotConfigWithGoogleTrends().catch(console.error);
