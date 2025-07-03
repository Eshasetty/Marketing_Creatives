// imageGenerator.js

const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');
// Import the specific OpenAI function from its dedicated file
const { generateAndSaveOpenAIImage } = require('./openai.js');
require('dotenv').config();

// Initialize clients (Flux specific)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);


/**
 * Generate image using Flux model and save to Supabase
 * @param {string} prompt - The image generation prompt directly provided to the function
 * @param {string} creativeId - The creative ID to associate with the image
 * @param {string} bucketName - Supabase storage bucket name (default: 'creative-images')
 * @returns {Promise<Object>} - Result object with image URL and metadata
 */
async function generateAndSaveFluxImage(prompt, creativeId, bucketName = 'creative-images') {
  try {
    console.log(`🎨 Generating Flux image for creative ${creativeId} with prompt: "${prompt}"`);

    // Step 1: Generate image with Flux
    const input = {
      prompt: prompt,
      // You can add more parameters here based on Flux model options
    };

    const output = await replicate.run("black-forest-labs/flux-schnell", { input });

    if (!output || output.length === 0) {
      throw new Error('No image generated from Flux model');
    }

    // Step 2: Fetch the generated image
    const imageUrl = output[0]; // Flux returns array of URLs
    console.log(`✅ Flux image generated: ${imageUrl}`);

    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch generated Flux image: ${imageResponse.statusText}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageUint8Array = new Uint8Array(imageBuffer);

    // Step 3: Create filename and path
    const timestamp = Date.now();
    const filename = `creative_${creativeId}_flux_${timestamp}.webp`;
    const filePath = `creatives/${filename}`;

    // Step 4: Upload to Supabase Storage
    console.log(`📤 Uploading Flux image to Supabase: ${filePath}`);

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(filePath, imageUint8Array, {
        contentType: 'image/webp',
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      throw new Error(`Supabase upload failed for Flux image: ${uploadError.message}`);
    }

    // Step 5: Get public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;
    console.log(`✅ Flux image uploaded successfully: ${publicUrl}`);

    // Step 6: Update creative record with image URL
    const { error: updateError } = await supabase
      .from('creatives_duplicate')
      .update({
        imagery: { // Update the main 'imagery' column
          url: publicUrl,
          alt_text: prompt,
          generated_at: new Date().toISOString(),
          model: 'flux-schnell',
          original_prompt: prompt
        }
      })
      .eq('creative_id', creativeId);

    if (updateError) {
      console.error(`❌ Failed to update creative record for Flux image: ${updateError.message}`);
      // Don't throw here - image is still saved successfully
    }

    return {
      success: true,
      image_url: publicUrl,
      file_path: filePath,
      creative_id: creativeId,
      prompt: prompt,
      model: 'flux-schnell'
    };

  } catch (error) {
    console.error(`❌ Flux image generation failed for creative ${creativeId}:`, error.message);
    return {
      success: false,
      error: error.message,
      creative_id: creativeId,
      prompt: prompt
    };
  }
}


/**
 * Generate images for multiple creatives in parallel, supporting both Flux and OpenAI.
 * This function now expects the prompt to be *within* each creative object,
 * or it can be passed directly if you only generate one at a time.
 * For multiple creatives, ensure each creative object has a 'prompt' field.
 *
 * @param {Array<Object>} creatives - Array of creative objects. Each object MUST have `creative_id` and `prompt` fields.
 * @param {string} modelType - 'flux' or 'openai' to specify which model to use
 * @param {number} maxConcurrent - Maximum concurrent generations (default: 3)
 * @returns {Promise<Array>} - Array of generation results
 */
async function generateImagesForCreatives(creatives, modelType = 'flux', maxConcurrent = 3) {
  console.log(`🎨 Starting ${modelType} image generation for ${creatives.length} creatives`);

  const results = [];

  // Process creatives in batches to avoid overwhelming the API
  for (let i = 0; i < creatives.length; i += maxConcurrent) {
    const batch = creatives.slice(i, i + maxConcurrent);
    console.log(`📦 Processing batch ${Math.floor(i/maxConcurrent) + 1} (${batch.length} items)`);

    const batchPromises = batch.map(creative => {
      const prompt = creative.prompt;
      if (!prompt) {
        console.warn(`Creative ${creative.creative_id} is missing a prompt. Skipping.`);
        return Promise.resolve({ success: false, error: 'Prompt missing', creative_id: creative.creative_id });
      }

      if (modelType === 'flux') {
        return generateAndSaveFluxImage(prompt, creative.creative_id);
      } else if (modelType === 'openai') {
        // Call the function from the new dedicated file
        return generateAndSaveOpenAIImage(prompt, creative.creative_id);
      } else {
        return Promise.resolve({ success: false, error: 'Invalid modelType specified', creative_id: creative.creative_id });
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Add small delay between batches to be respectful to the API
    if (i + maxConcurrent < creatives.length) {
      console.log('⏳ Waiting 2 seconds before next batch...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`✅ Image generation complete: ${successful} successful, ${failed} failed`);

  return results;
}

module.exports = {
  generateAndSaveFluxImage,
  generateAndSaveOpenAIImage, // Still export it if you want to call it directly from other files
  generateImagesForCreatives,
};