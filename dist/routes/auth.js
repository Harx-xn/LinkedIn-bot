"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prismaClient_1 = require("../prismaClient");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const router = (0, express_1.Router)();
router.post('/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Missing email or password' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!email.includes('@'))
        return res.status(400).json({ error: 'Invalid email format' });
    const existing = await prismaClient_1.prisma.user.findUnique({ where: { email } });
    if (existing)
        return res.status(400).json({ error: 'Email already in use' });
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    const user = await prismaClient_1.prisma.user.create({
        data: { email, passwordHash }
    });
    const token = jsonwebtoken_1.default.sign({ userId: user.id }, config_1.config.jwtSecret);
    res.json({ token, user: { id: user.id, email: user.email } });
});
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Missing email or password' });
    const user = await prismaClient_1.prisma.user.findUnique({ where: { email } });
    if (!user)
        return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (!ok)
        return res.status(400).json({ error: 'Invalid credentials' });
    const token = jsonwebtoken_1.default.sign({ userId: user.id }, config_1.config.jwtSecret);
    res.json({ token, user: { id: user.id, email: user.email } });
});
exports.default = router;
