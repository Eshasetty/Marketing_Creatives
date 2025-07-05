// imageGenerator.js

const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize clients (Flux specific)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Extract background description from aiText string
 * @param {string} aiText - The AI text containing background description
 * @returns {string|null} - The background description or null if not found
 */
function extractBackgroundDescription(aiText) {
  if (!aiText || typeof aiText !== 'string') {
    console.warn('aiText is not a valid string');
    return null;
  }

  // Look for "Background Description:" pattern
  const backgroundDescriptionRegex = /Background Description:\s*(.+?)(?=\n|$)/i;
  const match = aiText.match(backgroundDescriptionRegex);
  
  if (match && match[1]) {
    const description = match[1].trim();
    console.log(`✅ Extracted background description: "${description}"`);
    return description;
  }

  console.warn('No background description found in aiText');
  return null;
}

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

    // DEBUG: Check if environment variables are set
    if (!process.env.REPLICATE_API_TOKEN) {
      throw new Error('REPLICATE_API_TOKEN environment variable is not set');
    }
    if (!process.env.SUPABASE_URL) {
      throw new Error('SUPABASE_URL environment variable is not set');
    }
    if (!process.env.SUPABASE_KEY) {
      throw new Error('SUPABASE_KEY environment variable is not set');
    }

    // DEBUG: Validate inputs
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Prompt is required and must be a string');
    }
    if (!creativeId) {
      throw new Error('Creative ID is required');
    }

    console.log(`🔑 Environment variables check passed`);

    // Step 1: Generate image with Flux
    const input = {
      prompt: prompt,
      width: 1024,
      height: 1024,
      num_outputs: 1,
      num_inference_steps: 4, // Flux Schnell is optimized for 4 steps
    };

    console.log(`🚀 Calling Flux model...`);

    const output = await replicate.run("black-forest-labs/flux-schnell", { input });

    console.log(`📤 Flux model response received`);

    if (!output || output.length === 0) {
      throw new Error('No image generated from Flux model');
    }

    // Step 2: Fetch the generated image
    const imageUrl = output[0]; // Flux returns array of URLs
    console.log(`✅ Flux image generated: ${imageUrl}`);

    console.log(`📥 Fetching image from URL...`);
    const imageResponse = await fetch(imageUrl);

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch generated Flux image: ${imageResponse.status} ${imageResponse.statusText}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageUint8Array = new Uint8Array(imageBuffer);

    console.log(`📏 Image buffer size: ${imageBuffer.byteLength} bytes`);

    // Step 3: Create filename and path
    const timestamp = Date.now();
    const filename = `creative_${creativeId}_flux_${timestamp}.webp`;
    const filePath = `creatives/${filename}`;

    console.log(`📂 File path: ${filePath}`);

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
      console.error(`❌ Supabase upload error details:`, uploadError);
      throw new Error(`Supabase upload failed for Flux image: ${uploadError.message}`);
    }

    console.log(`✅ Upload successful`);

    // Step 5: Get public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;
    console.log(`✅ Flux image uploaded successfully: ${publicUrl}`);

    // Step 6: Update creative record with image URL
    console.log(`📝 Updating creative record for ID: ${creativeId}`);
    
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
      console.log(`⚠️ Image saved successfully but database update failed`);
    } else {
      console.log(`✅ Database record updated successfully`);
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
    console.error(`❌ Full error details:`, error);
    return {
      success: false,
      error: error.message,
      creative_id: creativeId,
      prompt: prompt
    };
  }
}

/**
 * Generate image from aiText (extracts background description automatically)
 * This is the main function you should call from your API
 * @param {string} aiText - The AI text containing background description
 * @param {string} creativeId - The creative ID to associate with the image
 * @param {string} bucketName - Supabase storage bucket name (default: 'creative-images')
 * @returns {Promise<Object>} - Result object with image URL and metadata
 */
async function generateImageFromAiText(aiText, creativeId, bucketName = 'creative-images') {
  try {
    console.log(`🎯 Processing aiText for creative ${creativeId}`);
    
    // Extract background description from aiText
    const backgroundDescription = extractBackgroundDescription(aiText);
    
    if (!backgroundDescription) {
      throw new Error('No background description found in aiText');
    }

    console.log(`🎨 Found background description: "${backgroundDescription}"`);

    // Generate image using the extracted prompt
    const result = await generateAndSaveFluxImage(backgroundDescription, creativeId, bucketName);
    
    return result;

  } catch (error) {
    console.error(`❌ Failed to generate image from aiText:`, error.message);
    return {
      success: false,
      error: error.message,
      creative_id: creativeId
    };
  }
}

/**
 * Generate images for multiple creatives in parallel using ONLY Flux.
 * This function now expects the prompt to be *within* each creative object,
 * or it can be passed directly if you only generate one at a time.
 * For multiple creatives, ensure each creative object has a 'prompt' field.
 *
 * @param {Array<Object>} creatives - Array of creative objects. Each object MUST have `creative_id` and `prompt` fields.
 * @param {number} maxConcurrent - Maximum concurrent generations (default: 3)
 * @returns {Promise<Array>} - Array of generation results
 */
async function generateImagesForCreatives(creatives, maxConcurrent = 3) {
  console.log(`🎨 Starting Flux image generation for ${creatives.length} creatives`);

  // DEBUG: Validate input
  if (!Array.isArray(creatives) || creatives.length === 0) {
    throw new Error('Creatives must be a non-empty array');
  }

  // Prepare creatives - extract prompts from aiText OR background.description
  const creativesWithPrompts = creatives.map(creative => {
    let prompt = null;

    if (creative.prompt) {
      // Case 1: Prompt is already directly on the creative object
      prompt = creative.prompt;
      console.log(`🔍 Prompt found at top-level for ${creative.creative_id}`);
    } else if (creative.aiText) {
      // Case 2: Prompt can be extracted from aiText
      prompt = extractBackgroundDescription(creative.aiText);
      console.log(`🔍 Prompt extracted from aiText for ${creative.creative_id}`);
    } else if (creative.background && creative.background.description) { // <--- THIS IS THE KEY ADDITION
      // Case 3: Prompt can be extracted from creative.background.description
      prompt = creative.background.description;
      console.log(`🔍 Prompt extracted from creative.background.description for ${creative.creative_id}`);
    }

    if (!prompt) {
      throw new Error(
        `Creative ${creative.creative_id} has neither a top-level 'prompt', 'aiText', nor 'background.description' to generate an image from.`
      );
    }
    
    // Attach the extracted/found prompt to the creative object for consistent use later
    return {
      ...creative,
      prompt: prompt 
    };
  });

  const results = [];

  // Process creatives in batches to avoid overwhelming the API
  for (let i = 0; i < creativesWithPrompts.length; i += maxConcurrent) {
    const batch = creativesWithPrompts.slice(i, i + maxConcurrent);
    console.log(`📦 Processing batch ${Math.floor(i/maxConcurrent) + 1} (${batch.length} items)`);

    const batchPromises = batch.map(creative => {
      // Now, 'creative.prompt' will definitely contain the description
      return generateAndSaveFluxImage(creative.prompt, creative.creative_id); 
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Add small delay between batches to be respectful to the API
    if (i + maxConcurrent < creativesWithPrompts.length) {
      console.log('⏳ Waiting 2 seconds before next batch...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`✅ Flux image generation complete: ${successful} successful, ${failed} failed`);

  return results;
}


/**
 * MAIN FUNCTION FOR YOUR API - Call this from your /api/save endpoint
 * Takes the exact data structure from your curl request
 * @param {Object} requestData - The data from your API request
 * @returns {Promise<Object>} - Result object with image URL and metadata
 */
async function processImageGenerationRequest(requestData) {
  try {
    const { campaignPrompt, aiText, generateImages } = requestData;
    
    if (!generateImages) {
      return {
        success: false,
        message: 'Image generation not requested'
      };
    }

    if (!aiText) {
      throw new Error('aiText is required for image generation');
    }

    // Generate a creative ID (you might want to pass this in or generate it differently)
    const creativeId = `creative_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    console.log(`🚀 Processing image generation request for campaign: "${campaignPrompt}"`);
    console.log(`🆔 Generated creative ID: ${creativeId}`);

    // Generate the image
    const result = await generateImageFromAiText(aiText, creativeId);

    if (result.success) {
      console.log(`✅ Image generation completed successfully`);
      console.log(`🖼️ Image URL: ${result.image_url}`);
    } else {
      console.log(`❌ Image generation failed: ${result.error}`);
    }

    return {
      ...result,
      campaign_prompt: campaignPrompt,
      creative_id: creativeId
    };

  } catch (error) {
    console.error(`❌ Failed to process image generation request:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  generateAndSaveFluxImage,
  generateImagesForCreatives,
  generateImageFromAiText,
  processImageGenerationRequest, // <-- Main function for your API
  extractBackgroundDescription
};