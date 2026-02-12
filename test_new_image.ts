import { ImageService } from './src/services/imageService';
import path from 'path';
import fs from 'fs';

async function testImage() {
    const service = new ImageService();
    // Use the user's uploaded image path from metadata
    const customBg = 'C:/Users/Pc Planet/.gemini/antigravity/brain/10a01523-1f3a-4481-b27f-5fcfdbcd1474/uploaded_image_0_1766145835971.png';

    const content = {
        headline: "Quantum Threat Drives Infrastructure Modernization",
        subheadline: "Proactive cryptographic hardening defines future business viability.",
        bulletPoints: [
            "Cryptographic agility is now a mandatory enterprise feature.",
            "The cost of delayed security modernization is technical debt.",
            "Web3 platforms are setting new standards for longevity."
        ]
    };

    console.log('Generating test image with custom background...');
    const resultPath = await service.createTopicImage(content.headline, customBg, content);
    console.log('Result saved to:', resultPath);
}

testImage().catch(console.error);
