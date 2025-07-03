// testOpenAIChatImage.js

require('dotenv').config(); // Make sure environment variables are loaded
// CORRECT PATH: Import from openaiChatImageService.js, which is in the same directory
const { generateAndSaveOpenAIImage } = require('./imageGenerator.js');

async function testOpenAIChatImage() {
  const creativeId = 'test-chat-image-123';
  const prompt = 'A cute, friendly robot giving a thumbs up, in a cartoon style, suitable for a chat application sticker.';

  console.log(`\n--- Starting isolated OpenAI Chat Image Test for creative: ${creativeId} ---\n`);

  const result = await generateAndSaveOpenAIImage(prompt, creativeId);

  console.log(`\n--- OpenAI Chat Image Test Result for creative: ${creativeId} ---`);
  console.log(result);

  if (result.success) {
    console.log(`Image saved to: ${result.image_url}`);
  } else {
    console.error(`Error: ${result.error}`);
  }
}

testOpenAIChatImage();