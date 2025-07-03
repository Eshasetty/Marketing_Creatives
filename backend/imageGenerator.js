// imageGenerator.js

const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize clients
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Generate image using Flux model and save to Supabase
 * @param {string} prompt - The image generation prompt
 * @param {string} creativeId - The creative ID to associate with the image
 * @param {string} bucketName - Supabase storage bucket name (default: 'creative-images')
 * @returns {Promise<Object>} - Result object with image URL and metadata
 */
async function generateAndSaveImage(prompt, creativeId, bucketName = 'creative-images') {
  try {
    console.log(`🎨 Generating image for creative ${creativeId} with prompt: "${prompt}"`);
    
    // Step 1: Generate image with Flux
    const input = {
      prompt: prompt,
      // You can add more parameters here based on Flux model options
      // width: 1024,
      // height: 1024,
      // num_inference_steps: 4,
      // guidance_scale: 0.0
    };

    const output = await replicate.run("black-forest-labs/flux-schnell", { input });
    
    if (!output || output.length === 0) {
      throw new Error('No image generated from Flux model');
    }

    // Step 2: Fetch the generated image
    const imageUrl = output[0]; // Flux returns array of URLs
    console.log(`✅ Image generated: ${imageUrl}`);
    
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch generated image: ${imageResponse.statusText}`);
    }
    
    const imageBuffer = await imageResponse.arrayBuffer();
    const imageUint8Array = new Uint8Array(imageBuffer);
    
    // Step 3: Create filename and path
    const timestamp = Date.now();
    const filename = `creative_${creativeId}_${timestamp}.webp`;
    const filePath = `creatives/${filename}`;
    
    // Step 4: Upload to Supabase Storage
    console.log(`📤 Uploading to Supabase: ${filePath}`);
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(filePath, imageUint8Array, {
        contentType: 'image/webp',
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      throw new Error(`Supabase upload failed: ${uploadError.message}`);
    }

    // Step 5: Get public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;
    console.log(`✅ Image uploaded successfully: ${publicUrl}`);

    // Step 6: Update creative record with image URL
    const { error: updateError } = await supabase
      .from('creatives_duplicate')
      .update({
        imagery: {
          url: publicUrl,
          alt_text: prompt,
          generated_at: new Date().toISOString(),
          model: 'flux-schnell',
          original_prompt: prompt
        }
      })
      .eq('creative_id', creativeId);

    if (updateError) {
      console.error(`❌ Failed to update creative record: ${updateError.message}`);
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
    console.error(`❌ Image generation failed for creative ${creativeId}:`, error.message);
    return {
      success: false,
      error: error.message,
      creative_id: creativeId,
      prompt: prompt
    };
  }
}

/**
 * Generate images for multiple creatives in parallel
 * @param {Array} creatives - Array of creative objects with id and background description
 * @param {number} maxConcurrent - Maximum concurrent generations (default: 3)
 * @returns {Promise<Array>} - Array of generation results
 */
async function generateImagesForCreatives(creatives, maxConcurrent = 3) {
  console.log(`🎨 Starting image generation for ${creatives.length} creatives`);
  
  const results = [];
  
  // Process creatives in batches to avoid overwhelming the API
  for (let i = 0; i < creatives.length; i += maxConcurrent) {
    const batch = creatives.slice(i, i + maxConcurrent);
    console.log(`📦 Processing batch ${Math.floor(i/maxConcurrent) + 1} (${batch.length} items)`);
    
    const batchPromises = batch.map(creative => {
      const prompt = creative.background?.description || 'abstract background design';
      return generateAndSaveImage(prompt, creative.creative_id);
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

/**
 * Enhanced prompt creation for better image generation
 * @param {Object} creative - Creative object with background and other details
 * @returns {string} - Enhanced prompt for image generation
 */
function createEnhancedImagePrompt(creative) {
  const baseDescription = creative.background?.description || 'abstract background';
  const placement = creative.placement || 'homepage';
  const format = creative.format || 'static';
  
  // Add context based on placement and format
  let enhancedPrompt = baseDescription;
  
  if (placement === 'social') {
    enhancedPrompt += ', social media friendly, high contrast, engaging';
  } else if (placement === 'email') {
    enhancedPrompt += ', email header style, clean, professional';
  } else if (placement === 'homepage') {
    enhancedPrompt += ', web banner style, modern, attractive';
  }
  
  // Add quality and style modifiers
  enhancedPrompt += ', high quality, professional, commercial photography, 4K resolution';
  
  // Ensure it's suitable for advertising
  enhancedPrompt += ', advertising background, clean composition, suitable for text overlay';
  
  return enhancedPrompt;
}

module.exports = {
  generateAndSaveImage,
  generateImagesForCreatives,
  createEnhancedImagePrompt
};