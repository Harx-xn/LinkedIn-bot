
import axios from 'axios';
import { prisma } from './prismaClient';
import jwt from 'jsonwebtoken';
import { config } from './config';

async function main() {
    // 1. Get the user
    const user = await prisma.user.findFirst();
    if (!user) throw new Error('No user found');
    console.log('User found:', user.email);

    // 2. Generate token
    const token = jwt.sign({ userId: user.id }, config.jwtSecret);
    console.log('Generated token');

    // 3. Create post via API
    console.log('Attempting to create post via API...');
    try {
        const res = await axios.post('http://localhost:4000/api/posts', {
            content: 'Debug Post via Script',
            source: 'MANUAL'
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Response:', res.status, res.data);
    } catch (err: any) {
        if (err.response) {
            console.error('API Error:', err.response.status, err.response.data);
        } else {
            console.error('Error:', err.message);
        }
    }
}

main();
