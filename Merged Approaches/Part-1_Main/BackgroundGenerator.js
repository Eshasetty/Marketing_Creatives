// imageGenerator2.js

const Replicate = require("replicate");
const { createClient } = require("@supabase/supabase-js");
// Import the specific OpenAI function from its dedicated file
const { generateAndSaveOpenAIImage } = require("./openai.js"); // Assuming openai.js also needs this logic
require("dotenv").config();

// Initialize clients
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Generate image using Flux model and save to Supabase
 * @param {string} prompt - The image generation prompt directly provided to the function
 * @param {string} creativeId - The creative ID to associate with the image
 * @param {string} bucketName - Supabase storage bucket name (default: 'creative-images')
 * @returns {Promise<Object>} - Result object with image URL and metadata
 */
async function generateAndSaveFluxImage(
  prompt,
  creativeId,
  bucketName = "creative-images"
) {
  try {
    console.log(
      `🎨 Generating Flux image for creative ${creativeId} with prompt: "${prompt}"`
    );

    // Step 1: Generate image with Flux
    const input = {
      prompt: prompt,
      // You can add more parameters here based on Flux model options
      // For black-forest-labs/flux-schnell, common parameters might include:
      // width: 1024,
      // height: 1024,
      // num_outputs: 1,
      // guidance_scale: 7.5,
      // lora_strength: 0.8,
      // controlnet_conditioning_scale: 0.8,
      // seed: 0 // You might want to generate a random seed or pass it
    };

    console.log(
      "🚀 Using Replicate API Key:",
      process.env.REPLICATE_API_TOKEN.slice(0, 5) + "...(hidden)"
    );

    const output = await replicate.run("black-forest-labs/flux-schnell", {
      input,
    });

    console.log(
      "🔬 Raw output from Replicate:",
      JSON.stringify(output, null, 2)
    );

    if (!output || output.length === 0) {
      throw new Error("No image generated from Flux model");
    }

    // Step 2: Fetch the generated image
    const imageUrl = output[0]; // Flux returns array of URLs
    console.log(`✅ Flux image generated: ${imageUrl}`);

    // Add a User-Agent header to your fetch request
    const imageResponse = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        // You can add other headers if needed, like 'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      },
    });

    if (!imageResponse.ok) {
      throw new Error(
        `Failed to fetch generated Flux image: ${imageResponse.statusText}. Status: ${imageResponse.status}` // Added status for more detail
      );
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageUint8Array = new Uint8Array(imageBuffer);

    // Step 3: Create filename and path
    const timestamp = Date.now();
    // Using .webp as Flux models often output efficient webp, or you can check output format
    const filename = `creative_${creativeId}_flux_${timestamp}.webp`;
    const filePath = `creatives/${filename}`;

    // Step 4: Upload to Supabase Storage
    console.log(`📤 Uploading Flux image to Supabase: ${filePath}`);

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(filePath, imageUint8Array, {
        contentType: "image/webp", // Adjust if Flux outputs a different format (e.g., image/jpeg, image/png)
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      throw new Error(
        `Supabase upload failed for Flux image: ${uploadError.message}`
      );
    }

    // Step 5: Get public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;
    console.log(`✅ Flux image uploaded successfully: ${publicUrl}`);

    // Step 6: Update creative record with image URL inside creative_spec
    // We need to fetch the existing creative_spec to avoid overwriting other fields
    const { data: currentCreative, error: fetchCreativeError } = await supabase
      .from("creatives_duplicate")
      .select("creative_spec")
      .eq("creative_id", creativeId)
      .single();

    console.log(
      "📥 Fetched current creative_spec from DB:",
      JSON.stringify(currentCreative, null, 2)
    );

    if (fetchCreativeError || !currentCreative) {
      console.error(
        `❌ Failed to fetch current creative_spec for ${creativeId}: ${
          fetchCreativeError?.message || "Creative not found"
        }`
      );
      // Decide if you want to throw here, or if it's acceptable to create a new creative_spec.
      // For this flow, assume creative_spec exists from OpenAI generation.
      throw new Error(
        `Creative ${creativeId} not found or creative_spec missing for image update.`
      );
    }

    const currentCreativeSpec = currentCreative.creative_spec || {};
    const updatedCreativeSpec = {
      ...currentCreativeSpec,
      Canvas: {
        // Ensure Canvas exists and merge into it
        ...(currentCreativeSpec.Canvas || {}),
        Imagery: {
          ...(currentCreativeSpec.Canvas?.Imagery || {}),
          background_image_url: publicUrl,
        },
      },
      // You can also add other metadata here, outside of Canvas if desired,
      // or within a new 'image_metadata' field in creative_spec
      image_generation_details: {
        alt_text: prompt,
        generated_at: new Date().toISOString(),
        model: "flux-schnell",
        original_prompt: prompt,
        file_path: filePath, // Keep file_path for reference
      },
    };

    console.log(
      "🛠 Updating creative_spec with:",
      JSON.stringify(updatedCreativeSpec, null, 2)
    );

    const { error: updateError } = await supabase
      .from("creatives_duplicate")
      .update({
        creative_spec: updatedCreativeSpec, // Update the creative_spec column
        status: "completed", // Mark creative as completed after image generation
      })
      .eq("creative_id", creativeId);

    if (updateError) {
      console.error(
        `❌ Failed to update creative record's creative_spec for Flux image: ${updateError.message}`
      );
      // Don't throw here if image is still saved successfully, but log the DB error.
    } else {
      console.log(
        `✅ creative_spec updated successfully in Supabase for ${creativeId}`
      );
    }

    return {
      success: true,
      image_url: publicUrl,
      file_path: filePath,
      creative_id: creativeId,
      prompt: prompt,
      model: "flux-schnell",
    };
  } catch (error) {
    console.error(
      `❌ Flux image generation failed for creative ${creativeId}:`,
      error.message
    );
    return {
      success: false,
      error: error.message,
      creative_id: creativeId,
      prompt: prompt,
    };
  }
}

/**
 * Generate images for multiple creatives in parallel, supporting both Flux and OpenAI.
 * This function now expects the prompt to be *within* each creative object's `background.description` field.
 *
 * @param {Array<Object>} creatives - Array of creative objects. Each object MUST have `creative_id` and `background.description` fields.
 * @param {string} modelType - 'flux' or 'openai' to specify which model to use
 * @param {number} maxConcurrent - Maximum concurrent generations (default: 3)
 * @returns {Promise<Array>} - Array of generation results
 */
async function generateImagesForCreatives(
  creatives,
  modelType = "flux",
  maxConcurrent = 1
) {
  console.log(
    `🎨 Starting ${modelType} image generation for ${creatives.length} creatives`
  );

  const results = [];

  // Process creatives in batches to avoid overwhelming the API
  for (let i = 0; i < creatives.length; i += maxConcurrent) {
    const batch = creatives.slice(i, i + maxConcurrent);
    console.log(
      `📦 Processing batch ${Math.floor(i / maxConcurrent) + 1} (${
        batch.length
      } items)`
    );

    const batchPromises = batch.map((creative) => {
      // Access background description directly from the creative object
      const prompt = creative.background?.description;
      if (!prompt) {
        console.warn(
          `Creative ${creative.creative_id} is missing a background description (prompt). Skipping.`
        );
        return Promise.resolve({
          success: false,
          error: "Prompt missing from creative.background.description",
          creative_id: creative.creative_id,
        });
      }

      if (modelType === "flux") {
        return generateAndSaveFluxImage(prompt, creative.creative_id);
      } else if (modelType === "openai") {
        // Call the function from the new dedicated file
        // Ensure generateAndSaveOpenAIImage also updates creative_spec correctly
        return generateAndSaveOpenAIImage(prompt, creative.creative_id);
      } else {
        return Promise.resolve({
          success: false,
          error: "Invalid modelType specified. Choose 'flux' or 'openai'.",
          creative_id: creative.creative_id,
        });
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Add small delay between batches to be respectful to the API
    if (i + maxConcurrent < creatives.length) {
      console.log("⏳ Waiting 2 seconds before next batch...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(
    `✅ Image generation complete: ${successful} successful, ${failed} failed`
  );

  return results;
}

module.exports = {
  generateAndSaveFluxImage,
  generateAndSaveOpenAIImage, // Still export it if you want to call it directly from other files
  generateImagesForCreatives,
};
