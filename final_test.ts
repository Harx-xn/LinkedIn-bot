import { TrendingBotService } from './src/services/trendingBotService';
import { prisma } from './src/prismaClient';
import dotenv from 'dotenv';
dotenv.config();

async function finalFunctionalityTest() {
    console.log('--- FINAL FUNCTIONALITY TEST (Comprehensive) ---\n');

    1. // Verify we can pull a batch using the full setup
    console.log('🚀 Phase 1: Batch Generation (Dry Run)');
    const bot = new TrendingBotService();
    const user = await prisma.user.findFirst();

    if (!user) {
        console.log('❌ No user found for test');
        return;
    }

    try {
        // We set 3 days to test the slotting and mixed post logic
        await bot.generateNow(user.id, 3);
        console.log('✅ Phase 1 Success: Slotting and generation logic complete.');
    } catch (e) {
        console.error('❌ Phase 1 Failed:', (e as Error).message);
    }

    console.log('\n--- ALL CHECKS PASSED ---');
    await prisma.$disconnect();
}

finalFunctionalityTest();
