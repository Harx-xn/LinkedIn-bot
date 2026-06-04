import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// The Neon serverless driver talks to Postgres over a secure WebSocket (port
// 443) instead of a raw TCP connection on 5432. This avoids environments where
// IPv6 routing to Neon/AWS is broken (Prisma's default TCP engine can stall on
// dead IPv6 routes and fail with P1001). Node's WebSocket/HTTPS stack uses
// Happy Eyeballs, so it falls back to IPv4 automatically.
neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({ connectionString });
const adapter = new PrismaNeon(pool);

export const prisma = new PrismaClient({ adapter });
