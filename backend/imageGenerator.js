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
 * Parses the raw aiText string into a structured creative object suitable for the database.
 * This is a placeholder function. YOU NEED TO IMPLEMENT ITS LOGIC.
 * It should extract all relevant fields (title, subtitle, background color, etc.)
 * from the aiText and return a structured object.
 *
 * @param {string} aiText - The raw AI generated text.
 * @returns {Object} - A structured creative object (excluding imagery initially).
 */
function parseAiTextToCreativeObject(aiText) {
  // --- IMPORTANT: YOU NEED TO IMPLEMENT THIS FUNCTION ---
  // This is where you'd parse the 'APPROACH:' format into the creative object structure.
  // Example (simplified):
  const creative = {
    placement: "center", // Example: derive from aiText
    dimensions: { width: 1200, height: 800 }, // Example: derive from aiText
    format: "static", // Example: derive from aiText
    background: {
      color: "#E6E6FA", // Example: derive from aiText
      type: "solid", // Example: derive from aiText
      description: extractBackgroundDescription(aiText) // Use your existing extraction
    },
    // ... parse other fields like text_blocks, cta_buttons, brand_logo, etc.
    // For now, I'll put a basic structure so it doesn't break, but it won't be fully populated.
    layout_grid: "free",
    bleed_safe_margins: null,
    text_blocks: [], // Populate this from aiText
    cta_buttons: [], // Populate this from aiText
    brand_logo: {}, // Populate this from aiText
    brand_colors: [], // Populate this from aiText
    slogan: "", // Populate this from aiText
    legal_disclaimer: "", // Populate this from aiText
    decorative_elements: [] // Populate this from aiText
  };

  // Example of parsing a few fields - expand this significantly!
  const titleMatch = aiText.match(/Title:\s*(.+)/);
  if (titleMatch) creative.text_blocks.push({ type: "headline", text: titleMatch[1].trim() });
  
  const subtitleMatch = aiText.match(/Subtitle:\s*(.+)/);
  if (subtitleMatch) creative.text_blocks.push({ type: "subhead", text: subtitleMatch[1].trim() });

  const ctaTextMatch = aiText.match(/CTA Button:\s*(.+)/);
  const ctaUrlMatch = aiText.match(/CTA URL:\s*(.+)/);
  const ctaBgColorMatch = aiText.match(/CTA BG Color:\s*(.+)/);
  const ctaTextColorMatch = aiText.match(/CTA Text Color:\s*(.+)/);
  if (ctaTextMatch && ctaUrlMatch) {
      creative.cta_buttons.push({
          text: ctaTextMatch[1].trim(),
          url: ctaUrlMatch[1].trim(),
          style: aiText.match(/CTA Style:\s*(.+)/)?.[1]?.trim() || 'primary',
          bg_color: ctaBgColorMatch?.[1]?.trim() || '#000000',
          text_color: ctaTextColorMatch?.[1]?.trim() || '#FFFFFF'
      });
  }

  const sloganMatch = aiText.match(/Slogan:\s*(.+)/);
  if (sloganMatch) creative.slogan = sloganMatch[1].trim();

  const legalDisclaimerMatch = aiText.match(/Legal Disclaimer:\s*(.+)/);
  if (legalDisclaimerMatch) creative.legal_disclaimer = legalDisclaimerMatch[1].trim();

  return creative;
}

/**
 * Extract background description from aiText string.
 * Uses a more robust regex to handle multi-line inputs and ensure "Background Description:" is found.
 * @param {string} aiText - The AI text containing background description.
 * @returns {string|null} - The background description or null if not found.
 */
function extractBackgroundDescription(aiText) {
  const match = aiText.match(/background description:\s*(.+)/i)
  if (match) {
    return match[1].trim()
  }

  console.warn("❌ Failed to extract background from aiText:", aiText)
  return "simple white background with no text or graphics" // fallback
}

/**
 * Generates an image using the Flux model and uploads it to Supabase Storage.
 * This function returns the metadata needed for the database record, but does NOT update the DB itself.
 *
 * @param {string} prompt - The image generation prompt directly provided.
 * @param {string} creativeId - The creative ID to associate with the image.
 * @param {string} bucketName - Supabase storage bucket name (default: 'creative-images').
 * @param {string} imageType - Type of image ('background' or 'poster') for filename and for the 'type' field in the DB array.
 * @returns {Promise<Object>} - Result object with image URL and metadata for later DB insertion.
 */
async function generateFluxImageToStorage(prompt, creativeId, bucketName = 'creative-images', imageType) {
  try {
    console.log(`🎨 Generating Flux ${imageType} image for creative ${creativeId} with prompt: "${prompt}"`);

    // Basic environment variable checks
    if (!process.env.REPLICATE_API_TOKEN) {
      throw new Error('REPLICATE_API_TOKEN environment variable is not set');
    }
    if (!process.env.SUPABASE_URL) {
      throw new Error('SUPABASE_URL environment variable is not set');
    }
    if (!process.env.SUPABASE_KEY) {
      throw new Error('SUPABASE_KEY environment variable is not set');
    }

    // Input validation
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') { // Added trim() check
      throw new Error(`Prompt for ${imageType} image is required and must be a non-empty string.`);
    }
    if (!creativeId) {
      throw new Error('Creative ID is required');
    }
    if (!imageType) {
        throw new Error('imageType is required (e.g., "background", "poster")');
    }

    console.log(`🔑 Environment variables check passed`);

    // Step 1: Generate image with Flux model
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
      throw new Error('No image generated from Flux model or output is empty');
    }

    // Step 2: Fetch the generated image from the URL provided by Replicate
    const imageUrl = output[0]; // Flux returns an array of URLs, take the first one
    console.log(`✅ Flux ${imageType} image generated: ${imageUrl}`);

    console.log(`📥 Fetching image from URL...`);
    const imageResponse = await fetch(imageUrl);

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch generated Flux ${imageType} image: ${imageResponse.status} ${imageResponse.statusText}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageUint8Array = new Uint8Array(imageBuffer);

    console.log(`📏 Image buffer size: ${imageBuffer.byteLength} bytes`);

    // Step 3: Create unique filename and storage path
    const timestamp = Date.now();
    const filename = `creative_${creativeId}_flux_${imageType}_${timestamp}.webp`;
    const filePath = `creatives/${filename}`;

    console.log(`📂 File path for upload: ${filePath}`);

    // Step 4: Upload image to Supabase Storage bucket
    console.log(`📤 Uploading Flux ${imageType} image to Supabase Storage: ${filePath}`);

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(filePath, imageUint8Array, {
        contentType: 'image/webp',
        cacheControl: '3600', // Cache for 1 hour
        upsert: false // Do not overwrite if file exists (unlikely with timestamp)
      });

    if (uploadError) {
      console.error(`❌ Supabase upload error details:`, uploadError);
      throw new Error(`Supabase upload failed for Flux ${imageType} image: ${uploadError.message}`);
    }

    console.log(`✅ Upload successful to Supabase Storage`);

    // Step 5: Get public URL of the uploaded image
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;
    console.log(`✅ Flux ${imageType} image publicly available at: ${publicUrl}`);

    // Return structured data for later database insertion
    return {
      success: true,
      type: imageType, // Crucial for the array structure in DB
      url: publicUrl,
      file_path: filePath,
      alt_text: prompt, // Use the prompt as alt text
      generated_at: new Date().toISOString(),
      model: 'flux-schnell',
      original_prompt: prompt
    };

  } catch (error) {
    console.error(`❌ Flux ${imageType} image generation and/or upload failed for creative ${creativeId}:`, error.message);
    console.error(`❌ Full error details:`, error);
    return {
      success: false,
      error: error.message,
      type: imageType, // Still return type even on error for context
      prompt: prompt || 'Prompt was undefined or empty' // Provide prompt for debugging
    };
  }
}

/**
 * Generates both background and poster images for multiple creatives in parallel.
 * Updates the 'imagery' JSONB array column for each creative in the database.
 * This function is primarily for batch processing and assumes creative objects
 * already exist in the database with their respective 'aiText' (or equivalent prompt source).
 *
 * @param {Array<Object>} creatives - Array of creative objects. Each object MUST have `creative_id` and `aiText`.
 * @param {number} maxConcurrent - Maximum concurrent generations (default: 3).
 * @returns {Promise<Array>} - Array of generation results for each creative.
 */
async function generateImagesForCreatives(creatives, maxConcurrent = 3) {
  console.log(`🎨 Starting batch Flux image generation for ${creatives.length} creatives (background and poster)`);

  if (!Array.isArray(creatives) || creatives.length === 0) {
    throw new Error('Creatives must be a non-empty array for batch generation.');
  }

  const allCreativeResults = [];

  // Process creatives in batches to manage API load
  for (let i = 0; i < creatives.length; i += maxConcurrent) {
    const batch = creatives.slice(i, i + maxConcurrent);
    console.log(`📦 Processing batch ${Math.floor(i/maxConcurrent) + 1} (${batch.length} items in this batch)`);

    const batchPromises = batch.map(async (creative) => {
      const creativeId = creative.creative_id;
      // This function assumes aiText is directly on the creative object for batch processing
      const aiText = creative.aiText; 

      console.log(`🔍 DEBUG (Batch): Processing creative ID: ${creativeId}`);
      console.log(`🔍 DEBUG (Batch): aiText received for creative ${creativeId}:`, aiText ? aiText.substring(0, 100) + '...' : 'NULL or UNDEFINED');

      if (!aiText || aiText.trim() === '') {
        console.warn(`⚠️ Skipping creative ${creativeId}: 'aiText' is missing or empty for image generation.`);
        return { creative_id: creativeId, success: false, error: 'Missing or empty aiText in creative data' };
      }

      const backgroundPrompt = extractBackgroundDescription(aiText);
      const posterPrompt = aiText;

      console.log(`🔍 DEBUG (Batch): Background Prompt for ${creativeId}: "${backgroundPrompt}"`);
      console.log(`🔍 DEBUG (Batch): Poster Prompt for ${creativeId}: "${posterPrompt ? posterPrompt.substring(0, 100) + '...' : 'NULL or UNDEFINED'}"`);

      if (!backgroundPrompt || backgroundPrompt.trim() === '') {
          console.error(`❌ Critical Error (Batch): 'Background Description' could not be extracted from aiText for creative ${creativeId}.`);
          return { creative_id: creativeId, success: false, error: "Failed to extract 'Background Description'." };
      }
      if (!posterPrompt || posterPrompt.trim() === '') {
          console.error(`❌ Critical Error (Batch): 'aiText' is empty or invalid for poster generation for creative ${creativeId}.`);
          return { creative_id: creativeId, success: false, error: "Invalid 'aiText' for poster generation." };
      }

      const [backgroundStorageResult, posterStorageResult] = await Promise.all([
        generateFluxImageToStorage(backgroundPrompt, creativeId, 'creative-images', 'background'),
        generateFluxImageToStorage(posterPrompt, creativeId, 'creative-images', 'poster')
      ]);

      const imageryArrayForDb = [];
      let currentCreativeOverallSuccess = true;

      if (backgroundStorageResult.success) {
        imageryArrayForDb.push(backgroundStorageResult); // Push the entire result object directly
      } else {
        currentCreativeOverallSuccess = false;
        console.error(`❌ Background image generation failed for creative ${creativeId}: ${backgroundStorageResult.error}`);
      }

      if (posterStorageResult.success) {
        imageryArrayForDb.push(posterStorageResult); // Push the entire result object directly
      } else {
        currentCreativeOverallSuccess = false;
        console.error(`❌ Poster image generation failed for creative ${creativeId}: ${posterStorageResult.error}`);
      }

      const { error: updateError } = await supabase
        .from('creatives_duplicate')
        .update({ imagery: imageryArrayForDb })
        .eq('creative_id', creativeId);

      if (updateError) {
        currentCreativeOverallSuccess = false;
        console.error(`❌ Failed to update creative record for ${creativeId} with combined imagery array: ${updateError.message}`);
        return { creative_id: creativeId, success: false, error: `Database update failed: ${updateError.message}` };
      } else {
        console.log(`✅ Database record updated successfully for creative ${creativeId} with imagery array`);
        return { creative_id: creativeId, success: currentCreativeOverallSuccess, savedImageryData: imageryArrayForDb };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    allCreativeResults.push(...batchResults);

    if (i + maxConcurrent < creatives.length) {
      console.log('⏳ Waiting 2 seconds before processing next batch...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const successfulCreatives = allCreativeResults.filter(r => r.success).length;
  const failedCreatives = allCreativeResults.filter(r => !r.success).length;

  console.log(`✅ Flux image generation and database updates complete for all creatives: ${successfulCreatives} successful, ${failedCreatives} failed`);

  return allCreativeResults;
}


/**
 * MAIN FUNCTION FOR YOUR API - Call this from your /api/save endpoint.
 * Orchestrates the entire process: parsing aiText, saving initial creative to DB,
 * generating background/poster images, and updating the DB with image URLs.
 *
 * @param {Object} requestData - The data from your API request, expected to contain
 * `campaignPrompt`, `aiText`, and `generateImages`.
 * Optionally, `creative_id` if updating an existing creative.
 * @returns {Promise<Object>} - Result object detailing the success/failure and generated image URLs/metadata.
 */
async function processImageGenerationRequest(requestData) {
  try {
    const { campaignPrompt, aiText, generateImages } = requestData;
    
    if (!generateImages) {
      console.log('ℹ️ Image generation not requested in input data, skipping.');
      return { success: false, message: 'Image generation not requested in input data.' };
    }

    if (!aiText || aiText.trim() === '') {
      throw new Error('`aiText` is required and must not be empty in the request data for creative and image generation.');
    }

    let creativeId = requestData.creative_id || `creative_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    console.log(`🚀 Processing request for campaign: "${campaignPrompt}"`);
    console.log(`🆔 Creative ID for this operation: ${creativeId}`);
    console.log(`🔍 Full aiText received for processing: ${aiText.substring(0, Math.min(aiText.length, 500))}...`); // Log up to 500 chars

    // --- Step 1: Parse aiText into structured creative object ---
    console.log('⚙️ Parsing aiText into structured creative object...');
    const creativeToSave = parseAiTextToCreativeObject(aiText);
    creativeToSave.creative_id = creativeId; // Ensure the generated/provided ID is used
    creativeToSave.campaign_id = campaignPrompt; // Assuming campaignPrompt directly maps to campaign_id

    // Initially, imagery is null or empty array, images will be added later
    creativeToSave.imagery = []; 
    
    // --- Step 2: Save initial creative object to database ---
    console.log(`📝 Attempting to save initial creative record with ID: ${creativeId} to database.`);
    const { data: savedCreativeData, error: saveError } = await supabase
      .from('creatives_duplicate')
      .upsert([creativeToSave], { onConflict: 'creative_id', ignoreDuplicates: false }) // Use upsert to handle new or existing creatives
      .select()
      .single();

    if (saveError) {
      console.error(`❌ Failed to save initial creative record for ${creativeId}: ${saveError.message}`);
      throw new Error(`Failed to save initial creative record: ${saveError.message}`);
    }
    console.log(`✅ Initial creative record saved/updated successfully with ID: ${savedCreativeData.creative_id}`);
    creativeId = savedCreativeData.creative_id; // Ensure we use the exact ID returned by DB

    // --- Step 3: Generate images using the original aiText prompts ---
    const backgroundPrompt = extractBackgroundDescription(aiText);
    const posterPrompt = aiText; // Full aiText for poster

    console.log(`🔍 DEBUG: Background Prompt for ${creativeId}: "${backgroundPrompt}"`);
    console.log(`🔍 DEBUG: Poster Prompt for ${creativeId}: "${posterPrompt ? posterPrompt.substring(0, Math.min(posterPrompt.length, 500)) + '...' : 'NULL or UNDEFINED'}"`);

    // Validate prompts before calling image generation
    if (!backgroundPrompt || backgroundPrompt.trim() === '') {
        console.error(`❌ Critical Error: 'Background Description' could not be extracted from aiText. Background image generation will fail.`);
        // Don't throw here directly, allow poster generation to attempt. Mark background as failed.
        // It will be caught by backgroundStorageResult.success check below.
    }
    if (!posterPrompt || posterPrompt.trim() === '') {
        console.error(`❌ Critical Error: 'aiText' is empty or invalid for poster generation. Poster image generation will fail.`);
        // Don't throw here directly, mark poster as failed.
    }

    const [backgroundStorageResult, posterStorageResult] = await Promise.all([
      generateFluxImageToStorage(backgroundPrompt, creativeId, 'creative-images', 'background'),
      generateFluxImageToStorage(posterPrompt, creativeId, 'creative-images', 'poster')
    ]);

    // --- Step 4: Prepare imagery array for DB update ---
    const imageryArrayForDb = [];
    let overallRequestSuccess = true;
    let errorsEncountered = [];

    if (backgroundStorageResult.success) {
      imageryArrayForDb.push(backgroundStorageResult);
      console.log(`✅ Background image generated and prepared: ${backgroundStorageResult.url}`);
    } else {
      overallRequestSuccess = false;
      errorsEncountered.push(`Background image generation failed: ${backgroundStorageResult.error}`);
      console.error(`❌ Background image generation failed: ${backgroundStorageResult.error}`);
    }

    if (posterStorageResult.success) {
      imageryArrayForDb.push(posterStorageResult);
      console.log(`✅ Poster image generated and prepared: ${posterStorageResult.url}`);
    } else {
      overallRequestSuccess = false;
      errorsEncountered.push(`Poster image generation failed: ${posterStorageResult.error}`);
      console.error(`❌ Poster image generation failed: ${posterStorageResult.error}`);
    }

    // --- Step 5: Update the creative record with the generated imagery ---
    console.log(`📝 Attempting to update creative record for ID: ${creativeId} with the generated imagery array.`);
    const { error: updateError } = await supabase
      .from('creatives_duplicate')
      .update({ imagery: imageryArrayForDb })
      .eq('creative_id', creativeId);

    if (updateError) {
      overallRequestSuccess = false;
      errorsEncountered.push(`Database update for imagery failed: ${updateError.message}`);
      console.error(`❌ Failed to update creative record for ${creativeId} with imagery array: ${updateError.message}`);
    } else {
      console.log(`✅ Database record updated successfully for creative ${creativeId} with imagery array`);
    }

    // Return the comprehensive result
    return {
      success: overallRequestSuccess,
      campaign_id: campaignPrompt, // Use campaignPrompt as campaign_id in response
      creative_id: creativeId,
      results: {
        initialCreativeSave: savedCreativeData,
        backgroundGeneration: backgroundStorageResult, 
        posterGeneration: posterStorageResult,
        final_imagery_saved_to_db: imageryArrayForDb
      },
      error: errorsEncountered.length > 0 ? errorsEncountered.join('; ') : null
    };

  } catch (error) {
    console.error(`❌ An unhandled error occurred during processImageGenerationRequest:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Export the functions
module.exports = {
  generateFluxImageToStorage, // Helper function, primarily for internal use
  generateImagesForCreatives, // For batch processing (if you use it separately)
  processImageGenerationRequest, // <-- The new, central API entry point
  extractBackgroundDescription, // Utility function
  parseAiTextToCreativeObject // Placeholder for your parsing logic
};