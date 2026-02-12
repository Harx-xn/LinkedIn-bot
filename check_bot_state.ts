import { prisma } from './src/prismaClient';

async function checkConfig() {
    const config = await prisma.botConfig.findFirst();
    console.log('Bot Config:', JSON.stringify(config, null, 2));

    const count = await prisma.post.count();
    console.log('Total posts:', count);

    const recentPosts = await prisma.post.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' }
    });
    console.log('Recent posts:', JSON.stringify(recentPosts, null, 2));

    await prisma.$disconnect();
}

checkConfig();
