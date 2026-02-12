const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function testGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('API Key exists:', !!apiKey);
    console.log('API Key (first 10 chars):', apiKey?.substring(0, 10));

    const genAI = new GoogleGenerativeAI(apiKey);

    // Test with gemini-pro
    console.log('\nTesting gemini-pro model...');
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
        const result = await model.generateContent('Write a short headline about AI in 5 words');
        const response = await result.response;
        console.log('✅ SUCCESS! Response:', response.text());
    } catch (error) {
        console.error('❌ FAILED:', error.message);
    }
}

testGemini();
