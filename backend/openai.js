// openaiChatImageService.js

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai'); // Import OpenAI library
require('dotenv').config();

// Initialize clients (ensure these are accessible or passed)
// For simplicity, we'll re-initialize them here. In a larger app,
// you might pass these instances from a central initialization.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate image using OpenAI (DALL-E 3 via GPT-4o) and save to Supabase
 * @param {string} prompt - The image generation prompt directly provided to the function
 * @param {string} creativeId - The creative ID to associate with the image
 * @param {string} bucketName - Supabase storage bucket name (default: 'creative-images')
 * @returns {Promise<Object>} - Result object with image URL and metadata
 */
async function generateAndSaveOpenAIImage(prompt, creativeId, bucketName = 'creative-images') {
  try {
    console.log(`💬 [OpenAI] Starting image generation for creative ${creativeId} with prompt: "${prompt}"`);

    // --- STEP 1: Generate image with OpenAI ---
    let response;
    try {
      response = await openai.images.generate({
        model: "dall-e-3",
        prompt: prompt,
        n: 1,
        size: "1024x1024",
        response_format: 'url',
      });
      console.log(`💬 [OpenAI] OpenAI API response received.`);
    } catch (apiError) {
      console.error(`❌ [OpenAI] Error from OpenAI API during generation for creative ${creativeId}:`, apiError.message);
      if (apiError.response && apiError.response.status) {
        console.error(`   Status: ${apiError.response.status}, Data:`, apiError.response.data);
      }
      throw new Error(`OpenAI API generation failed: ${apiError.message}`);
    }

    const imageUrl = response.data[0]?.url; // Use optional chaining to be safe
    if (!imageUrl) {
      console.error(`❌ [OpenAI] No image URL found in OpenAI response for creative ${creativeId}. Response data:`, response.data);
      throw new Error('No image URL received from OpenAI API');
    }
    console.log(`✅ [OpenAI] Image URL from OpenAI: ${imageUrl}`);

    // --- STEP 2: Fetch the generated image ---
    let imageResponse;
    try {
      imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        console.error(`❌ [OpenAI] Failed to fetch generated OpenAI image for creative ${creativeId}: HTTP Status ${imageResponse.status}, Text: ${imageResponse.statusText}`);
        throw new Error(`Failed to fetch generated OpenAI image: ${imageResponse.statusText}`);
      }
      console.log(`✅ [OpenAI] Image fetched successfully from URL.`);
    } catch (fetchError) {
      console.error(`❌ [OpenAI] Network error during image fetch for creative ${creativeId}:`, fetchError.message);
      throw new Error(`Network error fetching image: ${fetchError.message}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageUint8Array = new Uint8Array(imageBuffer);
    console.log(`✅ [OpenAI] Image buffer converted. Size: ${imageUint8Array.length} bytes.`);

    // --- STEP 3: Create filename and path ---
    const timestamp = Date.now();
    const filename = `creative_${creativeId}_openai_${timestamp}.png`; // DALL-E generates PNG
    const filePath = `creatives/${filename}`;
    console.log(`💬 [OpenAI] Prepared file path for Supabase: ${filePath}`);

    // --- STEP 4: Upload to Supabase Storage ---
    console.log(`📤 [OpenAI] Attempting upload to Supabase Storage bucket "${bucketName}" at "${filePath}"`);
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(filePath, imageUint8Array, {
        contentType: 'image/png', // Use image/png for DALL-E 3
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      console.error(`❌ [OpenAI] Supabase upload failed for creative ${creativeId}:`, uploadError.message);
      console.error(`   Supabase upload error details:`, uploadError); // Log full error object
      throw new Error(`Supabase upload failed: ${uploadError.message}`);
    }
    console.log(`✅ [OpenAI] Upload data:`, uploadData);

    // --- STEP 5: Get public URL ---
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;
    console.log(`✅ [OpenAI] Image uploaded successfully to Supabase. Public URL: ${publicUrl}`);

    // --- STEP 6: Update creative record with image URL ---
    console.log(`💬 [OpenAI] Attempting to update Supabase table 'creatives_duplicate' for creative ${creativeId}`);
    const { error: updateError } = await supabase
      .from('creatives_duplicate')
      .update({
        chat_imagery: { // Update a separate 'chat_imagery' column for chat-specific images
          url: publicUrl,
          alt_text: prompt,
          generated_at: new Date().toISOString(),
          model: 'dall-e-3 (gpt-4o)',
          original_prompt: prompt
        }
      })
      .eq('creative_id', creativeId);

    if (updateError) {
      console.error(`❌ [OpenAI] Failed to update creative record for OpenAI image: ${updateError.message}`);
      console.error(`   Supabase update error details:`, updateError); // Log full error object
    } else {
      console.log(`✅ [OpenAI] Creative record updated successfully for creative ${creativeId}.`);
    }

    return {
      success: true,
      image_url: publicUrl,
      file_path: filePath,
      creative_id: creativeId,
      prompt: prompt,
      model: 'dall-e-3 (gpt-4o)'
    };

  } catch (error) {
    console.error(`❌ [OpenAI] Overall Image generation failed for creative ${creativeId}:`, error.message);
    return {
      success: false,
      error: error.message,
      creative_id: creativeId,
      prompt: prompt
    };
  }
}

module.exports = {
  generateAndSaveOpenAIImage,
};