/// <reference types="node" />
import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  let region = await prisma.region.findUnique({
    where: { code: 'default' },
  });

  if (!region) {
    region = await prisma.region.create({
      data: {
        name: 'Default Region',
        slug: 'default-region',
        code: 'default',
        language: 'en',
        currency: 'USD',
        frontendVariant: 'default',
      },
    });
  }

  await prisma.user.updateMany({
    where: { regionId: null },
    data: { regionId: region.id, role: UserRole.USER },
  });

  await prisma.botConfig.updateMany({
    where: { regionId: null },
    data: { regionId: region.id },
  });

  await prisma.linkedInAccount.updateMany({
    where: { regionId: null },
    data: { regionId: region.id },
  });

  await prisma.schedule.updateMany({
    where: { regionId: null },
    data: { regionId: region.id },
  });

  await prisma.post.updateMany({
    where: { regionId: null },
    data: { regionId: region.id },
  });

  await prisma.botGenerationJob.updateMany({
    where: { regionId: null },
    data: { regionId: region.id },
  });

  await prisma.sheetConfig.updateMany({
    where: { regionId: null },
    data: { regionId: region.id },
  });

  console.log('Backfill completed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });