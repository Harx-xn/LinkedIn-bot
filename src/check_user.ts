import { prisma } from './prismaClient';
import bcrypt from 'bcryptjs';

async function main() {
    const email = 'ahsanilyas0000@gmail.com';
    const plainPassword = '12345678';

    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
        console.log(`User ${email} found with ID: ${user.id}`);
        const match = await bcrypt.compare(plainPassword, user.passwordHash);
        if (match) {
            console.log('Password verified successfully.');
        } else {
            console.log('Password mismatch. Resetting password...');
            const newHash = await bcrypt.hash(plainPassword, 10);
            await prisma.user.update({
                where: { id: user.id },
                data: { passwordHash: newHash }
            });
            console.log('Password has been reset to: ' + plainPassword);
        }
    } else {
        console.log(`User ${email} not found. Creating...`);
        const passwordHash = await bcrypt.hash(plainPassword, 10);
        const newUser = await prisma.user.create({
            data: { email, passwordHash }
        });
        console.log(`User created with ID: ${newUser.id}`);
    }
}

main()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
    });
