// imageGenerator.js - Updated to handle structured AI text format
const Replicate = require("replicate");
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY // Use service role key for updates
);

/**
 * Enhanced helper to parse structured fields from AI text
 * @param {string[]} lines - Array of text lines
 * @param {string} sectionName - The section to look for (e.g., "Background")
 * @param {string} fieldName - The field within the section (e.g., "description")
 * @returns {string|null} The parsed field value or null if not found
 */
function parseStructuredField(lines, sectionName, fieldName) {
  const sectionIndex = lines.findIndex(l => l.toLowerCase().trim().includes(sectionName.toLowerCase() + ":"));
  if (sectionIndex === -1) return null;
  
  // Look for the field within the next few lines after the section
  for (let i = sectionIndex + 1; i < Math.min(sectionIndex + 15, lines.length); i++) {
      const line = lines[i].toLowerCase().trim();
      if (line.startsWith(fieldName.toLowerCase() + ":")) {
          return lines[i].split(":").slice(1).join(":").trim();
      }
      // Stop if we hit another major section
      const majorSections = ["title:", "subtitle", "slogan:", "legal disclaimer:", "cta:", "background:", "branding:", "layout:", "decorative element:"];
      if (majorSections.some(section => line.includes(section)) && !line.startsWith(fieldName.toLowerCase())) {
          break;
      }
  }
  return null;
}

/**
* Creates an enhanced image prompt from structured AI text
* @param {string} aiText - The structured AI text from the LLM
* @returns {string} Enhanced image prompt for Flux
*/
function createEnhancedImagePrompt(aiText) {
  try {
      console.log("🔍 Parsing structured AI text for image prompt creation...");
      
      // Clean and split the AI text
      const cleanedText = aiText.replace(/^APPROACH:?\s*/i, '').trim();
      const lines = cleanedText.split("\n").map(l => l.trim()).filter(Boolean);
      
      // Extract key components using structured parsing
      const title = parseStructuredField(lines, "Title", "text") || "";
      const subtitle = parseStructuredField(lines, "Subtitle 1", "text") || "";
      const backgroundType = parseStructuredField(lines, "Background", "type")?.toLowerCase() || "solid";
      const backgroundDescription = parseStructuredField(lines, "Background", "description") || "";
      const backgroundColorStr = parseStructuredField(lines, "Background", "color") || "#ffffff";
      const layout = parseStructuredField(lines, "Layout", "type")?.toLowerCase() || "free";
      const decorativeShape = parseStructuredField(lines, "Decorative Element", "shape")?.toLowerCase() || "none";
      
      console.log("📝 Extracted components:");
      console.log(`- Title: "${title}"`);
      console.log(`- Subtitle: "${subtitle}"`);
      console.log(`- Background Type: "${backgroundType}"`);
      console.log(`- Background Description: "${backgroundDescription}"`);
      console.log(`- Background Color: "${backgroundColorStr}"`);
      console.log(`- Layout: "${layout}"`);
      console.log(`- Decorative Shape: "${decorativeShape}"`);
      
      // Validate that we have the essential background description
      if (!backgroundDescription || backgroundDescription.trim() === "" || backgroundDescription.toLowerCase() === "n/a") {
          console.error("❌ Critical Error: 'Background Description' could not be extracted from aiText or is empty.");
          console.error("Raw AI text for debugging:", aiText);
          throw new Error("Background description is required for image generation but was not found in the AI text.");
      }
      
      // Build the enhanced prompt based on background type
      let enhancedPrompt = "";
      
      if (backgroundType === "photo") {
          enhancedPrompt = `Create a high-quality photographic background image: ${backgroundDescription}. `;
          enhancedPrompt += `Professional photography style, high resolution, suitable for advertising creative. `;
          enhancedPrompt += `Clean composition with space for text overlay. `;
      } else if (backgroundType === "gradient") {
          enhancedPrompt = `Create a smooth gradient background: ${backgroundDescription}. `;
          enhancedPrompt += `Clean, modern gradient design suitable for advertising. `;
      } else if (backgroundType === "textured") {
          enhancedPrompt = `Create a textured background: ${backgroundDescription}. `;
          enhancedPrompt += `Subtle texture, not overpowering, suitable for text overlay. `;
      } else {
          // Default to solid/abstract
          enhancedPrompt = `Create a clean, modern background: ${backgroundDescription}. `;
          enhancedPrompt += `Minimal design suitable for advertising creative. `;
      }
      
      // Add layout considerations
      if (layout === "2-col" || layout === "3-col") {
          enhancedPrompt += `Design should accommodate a ${layout} layout structure. `;
      } else if (layout === "golden-ratio") {
          enhancedPrompt += `Design should follow golden ratio proportions. `;
      }
      
      // Add decorative elements if specified
      if (decorativeShape && decorativeShape !== "none") {
          enhancedPrompt += `Include subtle ${decorativeShape} decorative elements. `;
      }
      
      // Add final quality specifications
      enhancedPrompt += `High quality, professional advertising style, 16:9 aspect ratio, clean and modern aesthetic, suitable for brand advertising.`;
      
      console.log("✅ Enhanced image prompt created successfully:");
      console.log(enhancedPrompt);
      
      return enhancedPrompt;
      
  } catch (error) {
      console.error("❌ Error creating enhanced image prompt:", error);
      console.error("Raw AI text that caused the error:", aiText);
      throw error;
  }
}

/**
* Generates images for multiple creatives using Flux via Replicate
* @param {Array} creatives - Array of creative objects with creative_id and aiText
* @returns {Promise<Array>} Array of results for each creative
*/
async function generateImagesForCreatives(creatives) {
  const results = [];

  if (!process.env.REPLICATE_API_TOKEN) {
    console.error("❌ REPLICATE_API_TOKEN is not configured");
    return creatives.map(c => ({
      success: false,
      creative_id: c.creative_id,
      error: "REPLICATE_API_TOKEN not configured"
    }));
  }

  console.log(`🎨 Starting image generation for ${creatives.length} creatives...`);

  for (const creative of creatives) {
    try {
      console.log(`\n🖼️ Processing creative ${creative.creative_id}...`);

      const enhancedPrompt = createEnhancedImagePrompt(creative.aiText);

      // ✅ Use Replicate SDK (no polling)
      const output = await replicate.run("black-forest-labs/flux-schnell", {
        input: {
          prompt: enhancedPrompt,
          width: 1024,
          height: 1024,
          num_inference_steps: 4,
          guidance_scale: 0,
          num_outputs: 1
        }
      });

      const imageUrl = Array.isArray(output) ? output[0] : output;

      console.log(`✅ Image generated successfully for creative ${creative.creative_id}: ${imageUrl}`);

      // ✅ Update Supabase with the image URL
      const { error: updateError } = await supabase
        .from("creatives_duplicate")
        .update({
          imagery: [{ url: imageUrl, type: "generated", alt_text: "Generated background image" }]
        })
        .eq("creative_id", creative.creative_id);

      if (updateError) {
        console.error(`❌ Database update error:`, updateError);
        results.push({
          success: false,
          creative_id: creative.creative_id,
          error: `Database update failed: ${updateError.message}`,
          image_url: imageUrl
        });
      } else {
        console.log(`✅ Database updated successfully for creative ${creative.creative_id}`);
        results.push({
          success: true,
          creative_id: creative.creative_id,
          image_url: imageUrl
        });
      }

    } catch (error) {
      console.error(`❌ Critical Error for creative ${creative.creative_id}:`, error.message);
      results.push({
        success: false,
        creative_id: creative.creative_id,
        error: error.message
      });
    }
  }

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`\n✅ Flux image generation complete: ${successful} succeeded, ${failed} failed`);

  return results;
}

module.exports = {
  generateImagesForCreatives,
  createEnhancedImagePrompt,
  parseStructuredField
};

