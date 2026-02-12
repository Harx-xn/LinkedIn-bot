import { prisma } from './src/prismaClient';
import dotenv from 'dotenv';
dotenv.config();

async function checkFunctionality() {
    console.log('--- SYSTEM CHECK ---\n');

    // 1. Check DB & BotConfig
    try {
        const config = await prisma.botConfig.findFirst();
        console.log('✅ DATABASE: Connection successful');
        if (config) {
            console.log('✅ CONFIG: Found existing configuration');
            console.log(`   - Niches: ${(JSON.parse(config.niches)).length} configured`);
            console.log(`   - Custom RSS: ${(JSON.parse(config.customRssFeeds || '[]')).length} feeds`);
            console.log(`   - Custom Reddit: ${(JSON.parse(config.customRedditFeeds || '[]')).length} feeds`);
            console.log(`   - Custom Links: ${(JSON.parse(config.customLinks || '[]')).length} links`);
            console.log(`   - Enabled: ${config.isEnabled}`);
        } else {
            console.log('⚠️  CONFIG: No configuration found in DB');
        }
    } catch (e) {
        console.log('❌ DATABASE: Connection failed:', (e as Error).message);
    }

    // 2. Check Gemini Key
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
            console.log(`✅ GEMINI: API Key present (${apiKey.substring(0, 5)}...)`);
        } else {
            console.log('❌ GEMINI: API Key missing in .env');
        }
    } catch (e) {
        console.log('❌ GEMINI: Check failed');
    }

    // 3. Check Directory Structure (Simplified)
    const fs = require('fs');
    const requiredDirs = ['dist/public', 'prisma', 'src/services', 'src/routes'];
    requiredDirs.forEach(dir => {
        if (fs.existsSync(dir)) {
            console.log(`✅ DIR: ${dir} exists`);
        } else {
            console.log(`⚠️  DIR: ${dir} missing`);
        }
    });

    await prisma.$disconnect();
    console.log('\n--- CHECK COMPLETE ---');
}

checkFunctionality();
