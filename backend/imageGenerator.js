// imageGenerator.js

const Replicate = require('replicate');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize clients (Flux specific)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
// --- DYNAMIC AI TEXT PARSER ---
function parseDynamicAiText(aiText) {
  // Remove "APPROACH:" if present
  const cleanText = aiText.replace(/^APPROACH:?\s*/i, '').trim();
  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

  const fields = {};
  for (const line of lines) {
    // Match "Key: Value" (allowing for colons in the value)
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      // Support multiple values for the same key as arrays
      if (fields[key]) {
        if (Array.isArray(fields[key])) {
          fields[key].push(value);
        } else {
          fields[key] = [fields[key], value];
        }
      } else {
        fields[key] = value;
      }
    }
  }
  return fields;
}

/**
 * Enhanced extractPosterDescription - creates a focused visual prompt for poster generation
 */
function extractPosterDescription(aiText) {
  console.log('🔍 DEBUG: extractPosterDescription called with:', aiText ? aiText.substring(0, 100) + '...' : 'NULL/UNDEFINED');
  const fields = parseDynamicAiText(aiText);
  // Build a compact descriptive prompt using all available fields
  const parts = [];
  if (fields['Background Description']) parts.push(fields['Background Description']);
  if (fields['Decorative Element Shape']) parts.push(`decorative element: ${fields['Decorative Element Shape']}`);
  if (fields['Decorative Element Color']) parts.push(`decorative color: ${fields['Decorative Element Color']}`);
  if (fields['Background Color']) parts.push(`background color: ${fields['Background Color']}`);
  if (fields['Layout']) parts.push(`layout: ${fields['Layout']}`);
  if (fields['Title'] || fields['Subtitle']) {
    const textSummary = [fields['Title'], fields['Subtitle']].filter(Boolean).join(' — ');
    parts.push(`poster text: \"${textSummary}\"`);
  }
  if (fields['Slogan']) parts.push(`slogan: ${fields['Slogan']}`);
  if (fields['Legal Disclaimer']) parts.push(`legal: ${fields['Legal Disclaimer']}`);
  // Add any other fields dynamically
  for (const [key, value] of Object.entries(fields)) {
    if (!['Background Description','Decorative Element Shape','Decorative Element Color','Background Color','Layout','Title','Subtitle','Slogan','Legal Disclaimer'].includes(key)) {
      parts.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
  }
  const result = parts.join(', ');
  console.log('✅ Poster description generated:', result);
  return result;
}

function extractBackgroundDescription(aiText) {
  console.log('🔍 DEBUG: extractBackgroundDescription called with:', aiText ? aiText.substring(0, 100) + '...' : 'NULL/UNDEFINED');
  const lines = aiText.split('\n').map(l => l.trim());
  let inBackgroundSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^Background[:]?$/i.test(lines[i])) {
      inBackgroundSection = true;
      continue;
    }
    if (inBackgroundSection) {
      // End of section if we hit another top-level section
      if (/^(Title|Subtitle|Slogan|Legal Disclaimer|CTA|Branding|Layout|Decorative Element)[:]?$/i.test(lines[i])) {
        break;
      }
      // Look for description
      const match = lines[i].match(/^description:\s*(.+)$/i);
      if (match) {
        console.log('✅ Background description extracted successfully:', match[1]);
        return match[1];
      }
    }
  }
  // Fallback: try the dynamic parser for any top-level 'Background Description'
  const fields = parseDynamicAiText(aiText);
  const desc = fields['Background Description'] || fields['Background description'] || fields['Background'] || '';
  if (desc) {
    console.log('✅ Background description extracted successfully (fallback):', desc);
    return desc;
  }
  console.error("❌ Failed to extract background description from aiText");
  throw new Error("Background description not found in aiText. Expected a line like 'description: ...' under a 'Background' section.");
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

// Section-aware parser for AI text
function parseSectionedAiText(aiText) {
  const lines = aiText.split('\n').map(l => l.trim()).filter(Boolean);
  const result = {};
  let currentSection = null;

  for (const line of lines) {
    // Section header (e.g., Title, Subtitle 1, Slogan, etc.)
    if (/^(Title|Subtitle 1|Subtitle|Slogan|Legal Disclaimer|CTA|Background|Branding|Layout|Decorative Element)[:]?$/i.test(line)) {
      currentSection = line.replace(':', '');
      result[currentSection] = {};
      continue;
    }
    // Subfield (e.g., text: ...)
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match && currentSection) {
      const key = match[1].trim();
      const value = match[2].trim();
      result[currentSection][key] = value;
    }
  }
  return result;
}

module.exports = {
  parseDynamicAiText,
  extractBackgroundDescription,
  extractPosterDescription,
  testBackgroundExtraction
};
function parseAiTextToCreativeObject(aiText) {
  const fields = parseDynamicAiText(aiText);
  
  const creative = {
    placement: "center",
    dimensions: { width: 1200, height: 800 },
    format: "static",
    background: {
      color: fields['Background Color'] || '#000000', // Default to black if not found
      type: "solid",
      description: fields['Background Description'] || '' // Default to empty if not found
    },
    layout_grid: "free",
    bleed_safe_margins: null,
    text_blocks: [],
    cta_buttons: [],
    brand_logo: {},
    brand_colors: [],
    slogan: fields['Slogan'] || '',
    legal_disclaimer: fields['Legal Disclaimer'] || '',
    decorative_elements: []
  };

  // Add text blocks
  if (fields['Title']) creative.text_blocks.push({ type: "headline", text: fields['Title'] });
  if (fields['Subtitle']) creative.text_blocks.push({ type: "subhead", text: fields['Subtitle'] });

  // Add CTA button
  if (fields['CTA Text'] && fields['CTA URL']) {
    creative.cta_buttons.push({
      text: fields['CTA Text'],
      url: fields['CTA URL'],
      style: fields['CTA Style'] || 'primary',
      bg_color: fields['CTA Background Color'] || '#FF5733',
      text_color: fields['CTA Text Color'] || '#FFFFFF'
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
      //width: 1024,
      //height: 1024,
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
  parseSectionedAiText,
  generateFluxImageToStorage,
  generateImagesForCreatives,
  processImageGenerationRequest,
  extractBackgroundDescription,
  extractPosterDescription, 
  parseAiTextToCreativeObject,
};
