import { prisma } from '../src/prismaClient';

async function main() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "BotConfig"
    ADD COLUMN IF NOT EXISTS "brandLogoUrl" TEXT,
    ADD COLUMN IF NOT EXISTS "brandLogoEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "brandLogoPosition" TEXT NOT NULL DEFAULT 'bottomRight'
  `);

  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name::text AS column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'BotConfig'
      AND column_name IN ('brandLogoUrl', 'brandLogoEnabled', 'brandLogoPosition')
    ORDER BY column_name
  `;
  console.log('Brand logo columns:', columns.map((column) => column.column_name).join(', '));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
