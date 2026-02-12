import { prisma } from './src/prismaClient';

async function checkData() {
    console.log('=== Checking Bot Config ===');
    const configs = await prisma.botConfig.findMany();
    console.log(JSON.stringify(configs, null, 2));

    console.log('\n=== Checking Posts ===');
    const posts = await prisma.post.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10
    });
    console.log(`Total posts found: ${posts.length}`);
    console.log(JSON.stringify(posts, null, 2));

    await prisma.$disconnect();
}

checkData().catch(console.error);
