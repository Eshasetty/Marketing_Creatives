// server.js (Modified Version - Single Approach with User Input)

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { generateImagesForCreatives, createEnhancedImagePrompt } = require('./imageGenerator');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.OPENAI_API_KEY) {
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

if (!process.env.REPLICATE_API_TOKEN) {
  console.warn("⚠️  REPLICATE_API_TOKEN not found - image generation will be disabled");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// Enhanced cosine similarity function with better error handling
function cosineSimilarity(a, b) {
  try {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      throw new Error("Inputs must be arrays");
    }
    
    if (a.length !== b.length) {
      throw new Error("Arrays must have the same length");
    }

    const dot = a.reduce((sum, val, i) => sum + (val * b[i]), 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + (val * val), 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + (val * val), 0));
    
    if (magA === 0 || magB === 0) {
      return 0;
    }
    
    const similarity = dot / (magA * magB);
    
    // Ensure result is between -1 and 1
    return Math.max(-1, Math.min(1, similarity));
  } catch (error) {
    console.error("Error in cosineSimilarity:", error);
    return 0;
  }
}

async function findSimilarCampaigns(description) {
    try {
      // 1. Embed the input description
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description,
      });
      const inputEmbedding = embeddingResponse.data[0].embedding;
  
      // 2. Fetch existing campaigns
      const { data: campaigns, error: campaignError } = await supabase
        .from("campaigns")
        .select("campaign_id, campaign_prompt, embedding");
  
      if (campaignError || !campaigns?.length) {
        console.warn("⚠️ No campaigns found in Supabase.");
        return [];
      }
  
      // 3. Cosine similarity helper
      const cosineSimilarity = (a, b) => {
        const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
        const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
        const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
        return (magA && magB) ? dot / (magA * magB) : 0;
      };
  
      // 4. Calculate similarities
      const similarities = campaigns.map(c => {
        let emb = typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding;
        if (!Array.isArray(emb)) return null;
        return { ...c, similarity: cosineSimilarity(inputEmbedding, emb) };
      }).filter(Boolean)
        .filter(c => c.similarity > 0.2)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5); // Get top 5 for more inspiration
  
      if (!similarities.length) {
        console.log("📉 No similar campaigns found above threshold.");
        return [];
      }
  
      // 5. Get corresponding creatives
      const campaignIds = similarities.map(c => c.campaign_id);
  
      const { data: creatives, error: creativesError } = await supabase
        .from("creatives")
        .select("*")
        .in("campaign_id", campaignIds);
  
      if (creativesError) {
        console.error("⚠️ Error fetching creatives:", creativesError.message);
        return [];
      }
  
      // 6. Combine similar campaigns with their creatives
      const combinedData = similarities.map(campaign => {
        const creative = creatives?.find(cr => String(cr.campaign_id) === String(campaign.campaign_id));
        return {
          ...campaign,
          creative: creative || null
        };
      }).filter(item => item.creative !== null);
  
      // 7. Log similarity + creative match
      console.log("\n🎯 Similar Campaigns Found for Inspiration:\n");
  
      combinedData.forEach((item, i) => {
        console.log(`${i + 1}. "${item.campaign_prompt}" (${(item.similarity * 100).toFixed(2)}%)`);
        console.log(`   • Background: ${JSON.stringify(item.creative.background)}`);
        console.log(`   • Layout: ${item.creative.layout_grid}`);
        console.log(`   • CTA: ${JSON.stringify(item.creative.cta_buttons)}`);
        console.log();
      });
  
      console.log(`✅ Will use ALL ${combinedData.length} similar creatives as inspiration for 1 new creative\n`);
  
      return combinedData;
  
    } catch (err) {
      console.error("❌ Error in findSimilarCampaigns:", err.message);
      return [];
    }
  }
  
  
// STEP 2: Generate creative directions (MODIFIED - Single Approach)
async function generateCreativeDirections(campaignPrompt, similarCreatives = []) {
  try {
    console.log(`🎯 Generating creative direction using ${similarCreatives.length} similar creatives as inspiration`);

    // Format similar creatives for the prompt
    const similarCreativeText = similarCreatives.length > 0
      ? similarCreatives.map((item, i) => {
          const c = item.creative;
          return `Similar Creative ${i + 1}:\n` +
                 `Campaign: "${item.campaign_prompt}" (${(item.similarity * 100).toFixed(1)}% match)\n` +
                 `Title: ${c.text_blocks?.[0]?.text || 'N/A'}\n` +
                 `Subtitle: ${c.text_blocks?.[1]?.text || 'N/A'}\n` +
                 `Background: ${c.background?.type || 'N/A'} - ${c.background?.description || c.background?.color || 'N/A'}\n` +
                 `Layout: ${c.layout_grid || 'N/A'}\n` +
                 `Placement: ${c.placement || 'N/A'}\n` +
                 `Format: ${c.format || 'N/A'}\n` +
                 `CTA Button: ${c.cta_buttons?.[0]?.text || 'N/A'}`;
        }).join('\n\n')
      : 'No similar creatives found. Create original approach.';

    console.log("📝 Similar creatives context:", similarCreativeText);

    // Build the user message
    let userMessage = `Here is a campaign prompt:\n${campaignPrompt}\n\nHere are similar creatives from past campaigns to use as inspiration (create 1 new creative inspired by ALL of these):\n${similarCreativeText}`;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
You are a creative assistant for ad design.

Return 1 unique creative approach using the exact format below. Use all fields. If something doesn't apply, leave it blank.

In the Background Description:
- ONLY describe what visually appears: people, locations, objects, colors, textures, composition, lighting, style (e.g. realistic, flat)
- Do NOT use mood words like "inviting", "urgent", "exclusive", etc.
- Match the visual style of similar creatives if present. For example, if most similar campaigns use photo backgrounds with people or scenery, follow that pattern and same with solid colors or scenery.
- Avoid cluttered or overly busy backgrounds. Simpler compositions are preferred, but don't omit scenery if it's in the examples.

Follow this format exactly:

APPROACH:
Title:

text: [main headline]

font: [font family]

weight: [font weight]
color: [hex]

alignment: [left / center / right]

case: [sentence / upper / title]

Subtitle 1:

text: [subheadline]

font: [font family]

weight: [font weight]

color: [hex]

alignment: [left / center / right]

case: [sentence / upper / title]

Slogan:

text: Clothes made for capturing moments, creating memories and being unapologetically you.

Legal Disclaimer:

text: [optional legal text]

CTA:

text: [CTA button text]

url: [CTA target URL]

style: [primary / secondary / ghost]

bg_color: [hex]

text_color: [hex]

Background:

type: [photo / solid / gradient / textured]

color: [hex]

description: [detailed visual description]

Branding:

logo_alt_text: Hollister

Layout:

type: [free / 2-col / 3-col / golden-ratio]

placement: [homepage / email / app / social]

format: [static / gif / video / html5]

dimensions: [width]x[height]

Decorative Element:

shape: [line / blob / sticker]

color: [hex]



Only return the approach. No extra explanation.
          `.trim()
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const result = completion.choices[0].message.content;
    console.log("✅ Creative direction generated successfully");
    return result;

  } catch (error) {
    console.error("❌ Error generating creative directions:", error);
    return null;
  }
}

// STEP 3: Save campaign and creatives (MODIFIED - Single Approach)
async function saveCampaignPromptAndCreatives(prompt, aiText) {
    try {
      // Step 1: Embed prompt
      const embeddingRes = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: prompt,
      });
      const embedding = embeddingRes.data[0].embedding;
  
      // Step 2: Save to campaigns
      const { data: campaignInsert, error: campaignError } = await supabase
        .from("campaigns_duplicate")
        .insert([{ campaign_prompt: prompt, embedding }])
        .select();
  
      if (campaignError) {
        console.error("❌ Campaign insert error:", campaignError);
        throw campaignError;
      }
      
      const campaign_id = campaignInsert[0].campaign_id;
      console.log("✅ Campaign saved with ID:", campaign_id);
  
      // Step 3: Parse AI output - now expecting only 1 approach
      const approachText = aiText.replace(/^APPROACH:?\s*/i, '').trim();
      const lines = approachText.split("\n").map(l => l.trim()).filter(Boolean);
  
      const parseField = (lines, label) => {
        const line = lines.find(l => l.toLowerCase().startsWith(label.toLowerCase() + ":"));
        return line ? line.split(":").slice(1).join(":").trim() : null;
      };
  
      const dimensionsStr = parseField(lines, "Dimensions");
      const widthHeight = dimensionsStr?.split("x").map(x => parseInt(x.trim()));
      const dimensions = widthHeight?.length === 2 && !isNaN(widthHeight[0]) && !isNaN(widthHeight[1])
        ? { width: widthHeight[0], height: widthHeight[1] }
        : { width: 1080, height: 1920 };

      // Parse font weight safely
      const fontWeightStr = parseField(lines, "Font Weight");
      const fontWeight = fontWeightStr ? parseInt(fontWeightStr) : 400;
      const safeFontWeight = !isNaN(fontWeight) ? fontWeight : 400;

      // Validate layout_grid against schema constraints
      const rawLayout = parseField(lines, "Layout") || "free";
      const validLayouts = ["free", "2-col", "3-col", "golden-ratio"];
      const layout_grid = validLayouts.includes(rawLayout) ? rawLayout : "free";

      // Validate format against schema constraints  
      const rawFormat = parseField(lines, "Format") || "";
      const cleanedFormat = rawFormat.trim().toLowerCase();
      const validFormats = ["static", "gif", "video", "html5"];
      const format = validFormats.includes(cleanedFormat) ? cleanedFormat : "static";

      const textBlock = {
        type: "headline",
        text: parseField(lines, "Title") || "",
        font_family: parseField(lines, "Font Family") || "Arial",
        font_weight: safeFontWeight,
        color: parseField(lines, "Text Color") || "#000000",
        alignment: parseField(lines, "Text Alignment") || "left",
        case_style: parseField(lines, "Case Style") || "sentence"
      };

      const creative = {
        campaign_id,
        placement: parseField(lines, "Placement") || "homepage",
        dimensions,
        format,
        background: {
          color: parseField(lines, "Background Color") || "#ffffff",
          type: parseField(lines, "Background Type") || "solid",
          description: parseField(lines, "Background Description") || ""
        },
        layout_grid,
        bleed_safe_margins: null,
        imagery: null, // Will be populated after image generation
        text_blocks: [
          textBlock, 
          {
            type: "subhead",
            text: parseField(lines, "Subtitle") || "",
            font_family: parseField(lines, "Font Family") || "Arial",
            font_weight: safeFontWeight,
            color: parseField(lines, "Text Color") || "#000000",
            alignment: parseField(lines, "Text Alignment") || "left",
            case_style: parseField(lines, "Case Style") || "sentence"
          }
        ],
        cta_buttons: [{
          text: parseField(lines, "CTA Button") || "",
          url: parseField(lines, "CTA URL") || "",
          style: parseField(lines, "CTA Style") || "primary",
          bg_color: parseField(lines, "CTA BG Color") || "#007bff",
          text_color: parseField(lines, "CTA Text Color") || "#ffffff"
        }],
        brand_logo: {
          text_alt: parseField(lines, "Brand Logo Alt Text") || "Brand Logo"
        },
        brand_colors: ["#000000"],
        slogan: parseField(lines, "Slogan") || null,
        legal_disclaimer: parseField(lines, "Legal Disclaimer") || null,
        decorative_elements: [{
          shape_type: parseField(lines, "Decorative Element Shape") || "line",
          color: parseField(lines, "Decorative Element Color") || "#cccccc"
        }]
      };

      // Clean undefined values
      const cleanedCreative = JSON.parse(JSON.stringify(creative, (key, value) =>
        value === undefined ? null : value
      ));

      console.log(`🔍 Attempting to save creative:`, JSON.stringify(cleanedCreative, null, 2));

      const { data, error } = await supabase
        .from("creatives_duplicate")
        .insert([cleanedCreative])
        .select();
        
      if (error) {
        console.error(`❌ Creative insert error:`, error);
        console.error("❌ Error details:", JSON.stringify(error, null, 2));
        throw error;
      } else {
        console.log(`✅ Creative saved successfully.`);
        return {
          campaign_id,
          creative: data[0]
        };
      }

    } catch (err) {
      console.error("❌ Failed to save campaign and creative:", err);
      throw err; // Re-throw to be caught by endpoint
    }
}

// MAIN ENDPOINT: Generate initial approach
app.post('/api/generate', async (req, res) => {
  const { campaignPrompt } = req.body;
  
  if (!campaignPrompt) {
    return res.status(400).json({ error: "campaignPrompt is required" });
  }

  try {
    console.log("🔍 Starting generation for prompt:", campaignPrompt);
    
    // Step 1: Find similar creatives (returns combined data)
    const similarCreatives = await findSimilarCampaigns(campaignPrompt);
    console.log(`✅ Found ${similarCreatives.length} similar creatives to use as inspiration`);

    // Step 2: Generate creative direction using ALL similar creatives as inspiration
    const aiText = await generateCreativeDirections(campaignPrompt, similarCreatives);
    console.log("✅ Generated AI text:", aiText ? "Success" : "Failed");
    
    if (!aiText) {
      return res.status(500).json({ error: "Failed to generate creative direction" });
    }

    res.json({
      message: "Creative approach generated. Review and modify if needed.",
      aiText,
      similar_creatives_found: similarCreatives.length,
      ready_to_save: true
    });

  } catch (err) {
    console.error("❌ Error in /api/generate:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      details: err.message 
    });
  }
});

// NEW ENDPOINT: Modify the generated approach
app.post('/api/modify', async (req, res) => {
  const { originalAiText, modifications } = req.body;
  
  if (!originalAiText || !modifications) {
    return res.status(400).json({ error: "originalAiText and modifications are required" });
  }

  try {
    console.log("🔄 Modifying existing approach");
    console.log("🔄 User modifications:", modifications);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
You are a creative assistant for ad design. You will receive an existing creative approach and modification requests.

Apply the requested modifications to the existing approach while keeping the same format. Only change the fields that are mentioned in the modifications.
if a feild a new element is requested, add it to the end with the same format and subcategories.
Return the modified approach using the exact same format as the original with the changes applied.:

APPROACH:
Title:

text: [main headline]

font: [font family]

weight: [font weight]

color: [hex]

alignment: [left / center / right]

case: [sentence / upper / title]

Subtitle 1:

text: [subheadline]

font: [font family]

weight: [font weight]

color: [hex]

alignment: [left / center / right]

case: [sentence / upper / title]

Slogan:

text: Clothes made for capturing moments, creating memories and being unapologetically you.

Legal Disclaimer:

text: [optional legal text]

CTA:

text: [CTA button text]

url: [CTA target URL]

style: [primary / secondary / ghost]

bg_color: [hex]

text_color: [hex]

Background:

type: [photo / solid / gradient / textured]

color: [hex]

description: [detailed visual description]

Branding:

logo_alt_text: Hollister

Layout:

type: [free / 2-col / 3-col / golden-ratio]

placement: [homepage / email / app / social]

format: [static / gif / video / html5]

dimensions: [width]x[height]

Decorative Element:

shape: [line / blob / sticker]

color: [hex]



Only return the modified approach. No extra explanation.
          `.trim()
        },
        {
          role: "user",
          content: `Here is the existing creative approach:\n${originalAiText}\n\nPlease apply these modifications:\n${modifications}`
        }
      ]
    });

    const result = completion.choices[0].message.content;
    
    if (!result) {
      return res.status(500).json({ error: "Failed to generate modified creative direction" });
    }

    res.json({
      message: "Creative approach modified successfully.",
      aiText: result,
      modifications_applied: modifications,
      ready_to_save: true
    });

  } catch (err) {
    console.error("❌ Error in /api/modify:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      details: err.message 
    });
  }
});

// NEW ENDPOINT: Save the finalized approach
// NEW ENDPOINT: Save the finalized approach
app.post('/api/save', async (req, res) => {
    const { campaignPrompt, aiText, generateImages = true } = req.body;
    
    if (!campaignPrompt || !aiText) {
      return res.status(400).json({ error: "campaignPrompt and aiText are required" });
    }
  
    try {
      console.log("💾 Saving finalized approach");
      
      // Step 1: Save campaign and creative data to DB
      // This function will parse the aiText and save the creative,
      // returning the saved creative object (without the aiText string itself).
      const saveResult = await saveCampaignPromptAndCreatives(campaignPrompt, aiText);
      console.log("✅ Creative data saved to DB. Result:", saveResult);
  
      // Step 2: Generate images if requested and Replicate token is available
      let imageResults = [];
      if (generateImages && process.env.REPLICATE_API_TOKEN && saveResult.creative) {
        console.log("🎨 Starting image generation...");
        try {
          // Construct the object exactly as generateImagesForCreatives expects it:
          // It needs both the creative_id (from the DB save) AND the original aiText.
          const creativeForImageGen = {
            creative_id: saveResult.creative.creative_id, // Get the ID from the newly saved creative
            aiText: aiText // <<< IMPORTANT: Pass the original aiText from the request body here!
          };
          
          // Call the batch image generation function with our single prepared creative
          imageResults = await generateImagesForCreatives([creativeForImageGen]);
          console.log(`✅ Image generation completed: ${imageResults.length} results`);
  
          // The `generateImagesForCreatives` function already handles updating the DB's `imagery` column.
          // We just need to capture its results for the API response.
  
        } catch (imageError) {
          console.error("❌ Image generation failed at /api/save:", imageError.message);
          // Continue, don't block the entire response, but flag the error
          imageResults = [{ success: false, error: imageError.message, creative_id: saveResult.creative.creative_id }];
        }
      } else if (!generateImages) {
          console.log("ℹ️ Image generation explicitly skipped as per request.");
      } else if (!process.env.REPLICATE_API_TOKEN) {
          console.warn("⚠️ REPLICATE_API_TOKEN not found, skipping image generation.");
      } else if (!saveResult.creative) {
          console.warn("⚠️ Creative object not returned from save operation, skipping image generation.");
      }
  
  
      res.json({
        message: "Campaign and creative saved successfully.",
        campaign_id: saveResult.campaign_id,
        creative: saveResult.creative, // This is the initially saved creative object from DB
        image_generation_status: imageResults.length > 0 ? imageResults[0].success : false, // Check success of the first (and only) creative
        image_results: imageResults,
        aiText: aiText // Optionally return the aiText for client-side debugging/confirmation
      });
  
    } catch (err) {
      console.error("❌ Error in /api/save:", err);
      res.status(500).json({ 
        error: "Internal Server Error", 
        details: err.message 
      });
    }
  });

// Existing endpoint: Generate images for existing creatives
app.post('/api/generate-images', async (req, res) => {
  const { campaign_id } = req.body;
  
  if (!campaign_id) {
    return res.status(400).json({ error: "campaign_id is required" });
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    return res.status(400).json({ error: "REPLICATE_API_TOKEN not configured" });
  }

  try {
    // Fetch creatives for the campaign
    const { data: creatives, error } = await supabase
      .from('creatives_duplicate')
      .select('*')
      .eq('campaign_id', campaign_id);

    if (error) throw error;
    if (!creatives || creatives.length === 0) {
      return res.status(404).json({ error: "No creatives found for this campaign" });
    }

    console.log(`🎨 Generating images for ${creatives.length} creatives`);
    const imageResults = await generateImagesForCreatives(creatives);

    res.json({
      message: "Image generation completed",
      campaign_id,
      total_creatives: creatives.length,
      image_results: imageResults,
      images_generated: imageResults.filter(r => r.success).length,
      images_failed: imageResults.filter(r => !r.success).length
    });

  } catch (err) {
    console.error("❌ Error in /api/generate-images:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      details: err.message 
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});