import { TrendingBotService } from './services/trendingBotService';
import { prisma } from './prismaClient';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

async function main() {
    console.log('--- Testing Advanced Trending Bot ---');

    // 1. Setup Test User & Config
    const email = 'test_bot_user@example.com';
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        const passwordHash = await bcrypt.hash('password123', 10);
        user = await prisma.user.create({
            data: {
                email,
                passwordHash
            }
        });
        console.log('Created test user:', user.id);
    }

    // Upsert BotConfig
    await prisma.botConfig.upsert({
        where: { userId: user.id },
        create: {
            userId: user.id,
            niches: JSON.stringify(['Artificial Intelligence', 'Space Exploration']),
            sources: JSON.stringify(['reddit', 'medium', 'google']),
            backgroundImageUrl: '', // Test default background
            isEnabled: true
        },
        update: {
            niches: JSON.stringify(['Artificial Intelligence', 'Space Exploration']),
            sources: JSON.stringify(['reddit', 'medium', 'google']),
            isEnabled: true
        }
    });
    console.log('Upserted BotConfig for test user.');

    // 2. Run Bot
    const bot = new TrendingBotService();
    // Force a run (dryRun = true)
    await bot.runBot(true);

    console.log('--- Test Complete ---');
}

main()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
    });
