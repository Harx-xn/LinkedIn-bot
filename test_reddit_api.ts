import axios from 'axios';

async function testReddit() {
    const niches = ['Artificial Intelligence', 'Space Exploration'];
    for (const niche of niches) {
        const sanitizedNiche = niche.replace(/\s+/g, '');
        const url = `https://www.reddit.com/r/${sanitizedNiche}/top.json?limit=5&t=day`;
        console.log(`Testing URL: ${url}`);
        try {
            const { data } = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
            });
            console.log(`Success for ${niche}: ${data.data.children.length} items`);
        } catch (e: any) {
            console.error(`Failed for ${niche}:`, e.response?.status, e.response?.data);
        }
    }
}

testReddit();
