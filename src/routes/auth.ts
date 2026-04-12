import { Router } from 'express';
import { prisma } from '../prismaClient';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

const router = Router();

function isValidUsername(username: string) {
  // 3–20 chars, letters/numbers/underscore/dot, must start with letter or number
  return /^[a-zA-Z0-9][a-zA-Z0-9_.]{2,19}$/.test(username);
}

router.post('/register', async (req, res) => {
  const { email, password, username } = req.body as {
    email?: string;
    password?: string;
    username?: string;
  };

  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Missing email, password, or username' });
  }

  if (!email.includes('@')) return res.status(400).json({ error: 'Invalid email format' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!isValidUsername(username)) {
    return res.status(400).json({
      error: 'Invalid username (3–20 chars, letters/numbers/underscore/dot; must start with letter/number)'
    });
  }

  // Check email uniqueness
  
  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) return res.status(400).json({ error: 'Email already in use' });

  // Check username uniqueness
  const existingUsername = await prisma.user.findUnique({ where: { username } });
  if (existingUsername) return res.status(400).json({ error: 'Username already in use' });

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { email, username, passwordHash },
      select: { id: true, email: true, username: true }
    });

    const token = jwt.sign({ userId: user.id }, config.jwtSecret);
    res.json({ token, user });
  } catch (err: any) {
    // Prisma unique constraint fallback (race condition protection)
    if (err?.code === 'P2002') {
      const target = err?.meta?.target?.join?.(', ') || 'field';
      return res.status(400).json({ error: `Duplicate ${target}` });
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: user.id }, config.jwtSecret);

  // Return username too
  res.json({
  token,
  user: {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    regionId: user.regionId,
  },
});
});

export default router;
