const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkData() {
    try {
        console.log('\n=== BOT CONFIGURATIONS ===');
        const configs = await prisma.botConfig.findMany();
        console.log(JSON.stringify(configs, null, 2));

        console.log('\n=== RECENT POSTS (Last 10) ===');
        const posts = await prisma.post.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
                id: true,
                content: true,
                status: true,
                source: true,
                createdAt: true,
                mediaUrl: true
            }
        });
        console.log(JSON.stringify(posts, null, 2));

        await prisma.$disconnect();
    } catch (error) {
        console.error('Error:', error);
        await prisma.$disconnect();
    }
}

checkData();
