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
 * Improved parseAiTextFields with better regex patterns and debugging
 * @param {string} aiText - The AI-generated creative text
 * @returns {object} Parsed fields object
 */
function parseAiTextFields(aiText) {
  console.log('🔍 DEBUG: Parsing aiText:', aiText ? aiText.substring(0, 200) + '...' : 'NULL/UNDEFINED');
  
  if (!aiText || typeof aiText !== 'string') {
    console.error('❌ aiText is null, undefined, or not a string');
    return getEmptyFieldsObject();
  }

  // More flexible regex patterns that handle various formats
  const patterns = {
    title: [
      /Title:\s*(.+)/i,
      /^Title:\s*(.+)$/im,
      /\bTitle:\s*(.+)/i
    ],
    subtitle: [
      /Subtitle:\s*(.+)/i,
      /Sub-title:\s*(.+)/i,
      /^Subtitle:\s*(.+)$/im
    ],
    backgroundDescription: [
      /background description:\s*(.+)/i,
      /Background Description:\s*(.+)/i,
      /background:\s*(.+)/i,
      /Background:\s*(.+)/i,
      /^background description:\s*(.+)$/im,
      /^Background Description:\s*(.+)$/im
    ],
    backgroundColor: [
      /background color:\s*(.+)/i,
      /Background Color:\s*(.+)/i,
      /bg color:\s*(.+)/i,
      /^background color:\s*(.+)$/im
    ],
    layout: [
      /layout:\s*(.+)/i,
      /Layout:\s*(.+)/i,
      /^layout:\s*(.+)$/im
    ],
    decorativeElements: [
      /decorative elements:\s*(.+)/i,
      /Decorative Elements:\s*(.+)/i,
      /decorative:\s*(.+)/i,
      /^decorative elements:\s*(.+)$/im
    ],
    overallStyle: [
      /overall style:\s*(.+)/i,
      /Overall Style:\s*(.+)/i,
      /style:\s*(.+)/i,
      /^overall style:\s*(.+)$/im
    ],
    slogan: [
      /slogan:\s*(.+)/i,
      /Slogan:\s*(.+)/i,
      /^slogan:\s*(.+)$/im
    ],
    legalDisclaimer: [
      /legal disclaimer:\s*(.+)/i,
      /Legal Disclaimer:\s*(.+)/i,
      /disclaimer:\s*(.+)/i,
      /^legal disclaimer:\s*(.+)$/im
    ]
  };

  // CTA patterns
  const ctaPatterns = {
    text: [
      /CTA Button:\s*(.+)/i,
      /CTA Text:\s*(.+)/i,
      /Button Text:\s*(.+)/i,
      /^CTA Button:\s*(.+)$/im
    ],
    url: [
      /CTA URL:\s*(.+)/i,
      /CTA Link:\s*(.+)/i,
      /Button URL:\s*(.+)/i,
      /^CTA URL:\s*(.+)$/im
    ],
    style: [
      /CTA Style:\s*(.+)/i,
      /Button Style:\s*(.+)/i,
      /^CTA Style:\s*(.+)$/im
    ],
    bgColor: [
      /CTA BG Color:\s*(.+)/i,
      /CTA Background Color:\s*(.+)/i,
      /Button BG Color:\s*(.+)/i,
      /^CTA BG Color:\s*(.+)$/im
    ],
    textColor: [
      /CTA Text Color:\s*(.+)/i,
      /Button Text Color:\s*(.+)/i,
      /^CTA Text Color:\s*(.+)$/im
    ]
  };

  // Helper function to try multiple patterns
  function tryPatterns(patterns, text) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return '';
  }

  const fields = {
    title: tryPatterns(patterns.title, aiText),
    subtitle: tryPatterns(patterns.subtitle, aiText),
    backgroundDescription: tryPatterns(patterns.backgroundDescription, aiText),
    backgroundColor: tryPatterns(patterns.backgroundColor, aiText) || '#E6E6FA',
    layout: tryPatterns(patterns.layout, aiText),
    decorativeElements: tryPatterns(patterns.decorativeElements, aiText),
    overallStyle: tryPatterns(patterns.overallStyle, aiText),
    slogan: tryPatterns(patterns.slogan, aiText),
    legalDisclaimer: tryPatterns(patterns.legalDisclaimer, aiText),
    cta: {
      text: tryPatterns(ctaPatterns.text, aiText),
      url: tryPatterns(ctaPatterns.url, aiText),
      style: tryPatterns(ctaPatterns.style, aiText) || 'primary',
      bgColor: tryPatterns(ctaPatterns.bgColor, aiText) || '#000000',
      textColor: tryPatterns(ctaPatterns.textColor, aiText) || '#FFFFFF'
    }
  };

  // Debug logging for background description specifically
  console.log('🔍 DEBUG: Background description extracted:', fields.backgroundDescription);
  console.log('🔍 DEBUG: All extracted fields:', JSON.stringify(fields, null, 2));

  return fields;
}

function getEmptyFieldsObject() {
  return {
    title: '',
    subtitle: '',
    backgroundDescription: '',
    backgroundColor: '#E6E6FA',
    layout: '',
    decorativeElements: '',
    overallStyle: '',
    slogan: '',
    legalDisclaimer: '',
    cta: {
      text: '',
      url: '',
      style: 'primary',
      bgColor: '#000000',
      textColor: '#FFFFFF'
    }
  };
}

function extractBackgroundDescription(aiText) {
  console.log('🔍 DEBUG: extractBackgroundDescription called with:', aiText ? aiText.substring(0, 100) + '...' : 'NULL/UNDEFINED');
  
  const fields = parseAiTextFields(aiText);
  
  if (!fields.backgroundDescription) {
    console.error("❌ Failed to extract background description from aiText");
    console.error("❌ Available text for debugging:", aiText ? aiText.substring(0, 500) : 'NULL');
    throw new Error("Background description not found in aiText. Expected format: 'Background Description: ...' or 'background description: ...'");
  }
  
  console.log('✅ Background description extracted successfully:', fields.backgroundDescription);
  return fields.backgroundDescription;
}

/**
 * Enhanced extractPosterDescription - creates a focused visual prompt for poster generation
 */
function extractPosterDescription(aiText) {
  console.log('🔍 DEBUG: extractPosterDescription called with:', aiText ? aiText.substring(0, 100) + '...' : 'NULL/UNDEFINED');
  
  const fields = parseAiTextFields(aiText);
  
  // Build a compact descriptive prompt
  const parts = [];

  if (fields.backgroundDescription) {
    parts.push(fields.backgroundDescription);
  } else {
    throw new Error("Background description not found in aiText. Cannot generate poster without background description.");
  }
  
  if (fields.decorativeElements) parts.push(fields.decorativeElements);
  if (fields.backgroundColor) parts.push(`with a background color of ${fields.backgroundColor}`);
  if (fields.layout) parts.push(`using a ${fields.layout} layout`);
  
  if (fields.title || fields.subtitle) {
    const textSummary = [fields.title, fields.subtitle].filter(Boolean).join(' — ');
    parts.push(`poster text: "${textSummary}"`);
  }
  
  if (fields.overallStyle) parts.push(`style: ${fields.overallStyle}`);

  const result = parts.join(', ');
  console.log('✅ Poster description generated:', result);
  return result;
}

// Example usage and testing function
function testBackgroundExtraction(sampleAiText) {
  console.log('🧪 Testing background extraction with sample text...');
  
  const backgrounds = [
    extractBackgroundDescription(sampleAiText),
    extractPosterDescription(sampleAiText)
  ];
  
  console.log('📊 Test results:', {
    backgroundDescription: backgrounds[0],
    posterDescription: backgrounds[1]
  });
  
  return backgrounds;
}

module.exports = {
  parseAiTextFields,
  extractBackgroundDescription,
  extractPosterDescription,
  testBackgroundExtraction
};
function parseAiTextToCreativeObject(aiText) {
  const fields = parseAiTextFields(aiText);
  
  const creative = {
    placement: "center",
    dimensions: { width: 1200, height: 800 },
    format: "static",
    background: {
      color: fields.backgroundColor,
      type: "solid",
      description: fields.backgroundDescription
    },
    layout_grid: "free",
    bleed_safe_margins: null,
    text_blocks: [],
    cta_buttons: [],
    brand_logo: {},
    brand_colors: [],
    slogan: fields.slogan,
    legal_disclaimer: fields.legalDisclaimer,
    decorative_elements: []
  };

  // Add text blocks
  if (fields.title) creative.text_blocks.push({ type: "headline", text: fields.title });
  if (fields.subtitle) creative.text_blocks.push({ type: "subhead", text: fields.subtitle });

  // Add CTA button
  if (fields.cta.text && fields.cta.url) {
    creative.cta_buttons.push({
      text: fields.cta.text,
      url: fields.cta.url,
      style: fields.cta.style,
      bg_color: fields.cta.bgColor,
      text_color: fields.cta.textColor
    });
  }

  return creative;
}



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
      const posterPrompt = extractPosterDescription(aiText);

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
    const posterPrompt = extractPosterDescription(aiText);


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

module.exports = {
  generateFluxImageToStorage,
  generateImagesForCreatives,
  processImageGenerationRequest,
  extractBackgroundDescription,
  extractPosterDescription, 
  parseAiTextToCreativeObject
};
