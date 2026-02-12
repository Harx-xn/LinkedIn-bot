import { TrendsService } from './src/services/trendsService';
import dotenv from 'dotenv';
dotenv.config();

async function testGoogleTrendsFeeds() {
    console.log("Testing Google Trends RSS Feeds...\n");

    const trendsService = new TrendsService();

    // Test feeds from different regions
    const testFeeds = [
        'https://trends.google.com/trending/rss?geo=US',
        'https://trends.google.com/trending/rss?geo=GB',
        'https://trends.google.com/trending/rss?geo=AE',
        'https://trends.google.com/trending/rss?geo=SA'
    ];

    console.log(`Testing ${testFeeds.length} sample feeds...\n`);

    for (const feed of testFeeds) {
        try {
            console.log(`\n📡 Fetching: ${feed}`);
            const trends = await trendsService.fetchCustomRssTrends(feed);

            if (trends.length > 0) {
                console.log(`✅ SUCCESS - Found ${trends.length} trends`);
                console.log('\nSample trends:');
                trends.slice(0, 3).forEach((trend, idx) => {
                    console.log(`  ${idx + 1}. ${trend.title}`);
                    console.log(`     Link: ${trend.link}`);
                    console.log(`     Source: ${trend.source}`);
                });
            } else {
                console.log(`⚠️  No trends found (feed might be empty)`);
            }
        } catch (error: any) {
            console.log(`❌ FAILED: ${error.message}`);
        }
    }

    console.log('\n\n=== Testing with fetchTrends (with custom feeds) ===\n');

    // Test using the main fetchTrends method with custom RSS feeds
    const allFeeds = [
        'https://trends.google.com/trending/rss?geo=US',
        'https://trends.google.com/trending/rss?geo=GB',
        'https://trends.google.com/trending/rss?geo=DE',
        'https://trends.google.com/trending/rss?geo=AE',
        'https://trends.google.com/trending/rss?geo=SA'
    ];

    try {
        console.log(`Fetching trends for niche "Technology" with ${allFeeds.length} custom RSS feeds...`);
        const allTrends = await trendsService.fetchTrends('Technology', ['google'], allFeeds);

        console.log(`\n✅ Total trends collected: ${allTrends.length}`);
        console.log('\nTop 10 trends:');
        allTrends.slice(0, 10).forEach((trend, idx) => {
            console.log(`  ${idx + 1}. ${trend.title} (${trend.source})`);
        });
    } catch (error: any) {
        console.log(`❌ Failed to fetch combined trends: ${error.message}`);
    }

    console.log('\n✅ Test complete!');
}

testGoogleTrendsFeeds().catch(console.error);
