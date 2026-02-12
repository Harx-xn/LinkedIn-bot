const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey);

    try {
        // Try to list available models
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey);
        const data = await response.json();

        console.log('Available models:');
        if (data.models) {
            data.models.forEach(model => {
                console.log(`- ${model.name} (${model.displayName})`);
                console.log(`  Supported methods: ${model.supportedGenerationMethods?.join(', ')}`);
            });
        } else {
            console.log('Response:', JSON.stringify(data, null, 2));
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

listModels();
