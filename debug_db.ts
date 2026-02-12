
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const users = await prisma.user.findMany({ include: { posts: true } });
    console.log('Users:', JSON.stringify(users, null, 2));

    const posts = await prisma.post.findMany();
    console.log('All Posts:', JSON.stringify(posts, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
