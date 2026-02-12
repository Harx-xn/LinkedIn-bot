import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = 'ahsanilyas0000@gmail.com';
    const password = '12345678';
    console.log(`Hashing password for ${email}...`);
    const passwordHash = await bcrypt.hash(password, 10);

    console.log('Creating user...');
    const user = await prisma.user.upsert({
        where: { email },
        update: { passwordHash },
        create: {
            email,
            passwordHash,
        },
    });

    console.log(`User created/updated: ${user.email}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
