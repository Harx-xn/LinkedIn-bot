import { TrendsService } from './src/services/trendsService';

async function testFetchAll() {
    const service = new TrendsService();
    const niches = ['Artificial Intelligence', 'Space Exploration'];
    const sources = ['reddit', 'medium', 'google', 'linkedin'];

    for (const niche of niches) {
        console.log(`--- Testing Niche: ${niche} ---`);
        const trends = await service.fetchTrends(niche, sources);
        console.log(`Total trends found for ${niche}: ${trends.length}`);
        if (trends.length > 0) {
            console.log('Sample Trend:', trends[0].title, 'from', trends[0].source);
        }
    }
}

testFetchAll();
