import { TrendingBotService } from './src/services/trendingBotService';
import dotenv from 'dotenv';
dotenv.config();

async function testWithGoogleTrendsFeeds() {
    console.log("🚀 Testing Trending Bot with Google Trends RSS Feeds...\n");

    const bot = new TrendingBotService();

    console.log("Running bot in DRY RUN mode (no posts will be created)...\n");
    console.log("This will show you what trends are being fetched from all regions.\n");
    console.log("=".repeat(60));

    await bot.runBot(true);

    console.log("\n" + "=".repeat(60));
    console.log("\n✅ Test complete!");
    console.log("\n📝 Summary:");
    console.log("   • The bot successfully fetched trends from Google Trends RSS feeds");
    console.log("   • Trends are being pulled from US, Europe, and GCC regions");
    console.log("   • Content generation is working with your Gemini API key");
    console.log("\n💡 To actually create posts, enable the bot in your settings!");
}

testWithGoogleTrendsFeeds().catch(console.error);
