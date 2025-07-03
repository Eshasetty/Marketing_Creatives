// server.js (Complete Fixed Version)

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
        return { similarCampaigns: [], similarCreatives: [] };
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
        .slice(0, 3);
  
      if (!similarities.length) {
        console.log("📉 No similar campaigns found above threshold.");
        return { similarCampaigns: [], similarCreatives: [] };
      }
  
      // 5. Get corresponding creatives
      const campaignIds = similarities.map(c => c.campaign_id);
  
      const { data: creatives, error: creativesError } = await supabase
        .from("creatives")
        .select("*")
        .in("campaign_id", campaignIds);
  
      if (creativesError) {
        console.error("⚠️ Error fetching creatives:", creativesError.message);
      }
  
      // 6. Log similarity + creative match
      console.log("\n🎯 Top 3 Similar Campaigns:\n");
  
      similarities.forEach((c, i) => {
        const creative = creatives?.find(cr => String(cr.campaign_id) === String(c.campaign_id));
        console.log(`${i + 1}. "${c.campaign_prompt}" (${(c.similarity * 100).toFixed(2)}%)`);
        if (creative) {
          console.log(`   • Background: ${JSON.stringify(creative.background)}`);
          console.log(`   • Layout: ${creative.layout_grid}`);
          console.log(`   • CTA: ${JSON.stringify(creative.cta_buttons)}`);
        } else {
          console.log(`   ⚠️ No creative found for campaign ID ${c.campaign_id}`);
        }
        console.log();
      });
  
      return {
        similarCampaigns: similarities,
        similarCreatives: creatives?.filter(c =>
          campaignIds.includes(c.campaign_id)
        ) || []
      };
  
    } catch (err) {
      console.error("❌ Error in findSimilarCampaigns:", err.message);
      return { similarCampaigns: [], similarCreatives: [] };
    }
  }
  
  
// STEP 2: Generate creative directions (FIXED VERSION)
async function generateCreativeDirections(campaignPrompt, similarCreatives = []) {
  try {
    console.log(`🎯 Generating creative directions with ${similarCreatives.length} similar creatives`);

    // Format similar creatives for the prompt
    const similarCreativeText = similarCreatives.length > 0
      ? similarCreatives.map((c, i) => {
          return `Similar Creative ${i + 1}:\n` +
                 `Title: ${c.title || 'N/A'}\n` +
                 `Subtitle: ${c.subtitle || 'N/A'}\n` +
                 `Background Description: ${c.background?.description?.trim || '(none)'}\n` +
                 `Layout: ${c.layout_grid || 'N/A'}\n` +
                 `Placement: ${c.placement || 'N/A'}\n` +
                 `Format: ${c.format || 'N/A'}\n` +
                 `CTA Button: ${c.cta_buttons?.[0]?.text || 'N/A'}`;
        }).join('\n\n')
      : 'No similar creatives found. Create original approaches.';

    console.log("📝 Similar creatives context:", similarCreativeText);
    
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
You are a creative assistant for ad design.

Return 3 unique creative approaches using the exact format below. Use all fields. You may repeat fields like CTA or Subtitle if needed. If something doesn't apply, leave it blank.

In the Background Description:
- ONLY describe what visually appears: people, locations, objects, colors, textures, composition, lighting, style (e.g. realistic, flat)
- Do NOT use mood words like "inviting", "urgent", "exclusive", etc.
- Match the visual style of similar creatives if present. For example, if most similar campaigns use photo backgrounds with people or scenery, follow that pattern and same with solid colors or scenary.
- Avoid cluttered or overly busy backgrounds. Simpler compositions are preferred, but don't omit scenery if it's in the examples.
Each approach should follow this format exactly:

APPROACH 1:
Title: [headline]
Subtitle: [subheadline]
CTA Button: [text]
CTA URL: [url]
CTA Style: [primary / secondary / ghost]
CTA BG Color: [hex]
CTA Text Color: [hex]
Background Color: [hex]
Background Type: [photo / solid / gradient / textured]
Background Description: [detailed visual description]
Brand Logo Alt Text: [alt text]
Layout: [free / 2-col / 3-col / golden-ratio]
Placement: [homepage / email / app / social]
Format: [static / gif / video / html5]
Dimensions: [width]x[height]
Font Family: [font name]
Font Weight: [number]
Text Color: [hex]
Text Alignment: [left / center / right]
Case Style: [sentence / upper / title]
Decorative Element Shape: [line / blob / sticker]
Decorative Element Color: [hex]
Legal Disclaimer: 
Slogan: 

Only return the 3 approaches. No extra explanation.
          `.trim()
        },
        {
          role: "user",
          content: `
Here is a new campaign prompt:
${campaignPrompt}

Here are similar creatives from past campaigns for inspiration:
${similarCreativeText}
          `.trim()
        }
      ]
    });

    const result = completion.choices[0].message.content;
    console.log("✅ Creative directions generated successfully");
    return result;

  } catch (error) {
    console.error("❌ Error generating creative directions:", error);
    return null;
  }
}

// STEP 3: Save campaign and creatives (Keep your existing function)
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
  
      // Step 3: Parse AI output
      const approaches = aiText
        .split(/APPROACH \d:/i)
        .map(x => x.trim())
        .filter(Boolean);
  
      const parseField = (lines, label) => {
        const line = lines.find(l => l.toLowerCase().startsWith(label.toLowerCase() + ":"));
        return line ? line.split(":").slice(1).join(":").trim() : null;
      };
  
      const savedCreatives = [];
  
      for (let i = 0; i < approaches.length; i++) {
        const lines = approaches[i].split("\n").map(l => l.trim()).filter(Boolean);
  
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
  
        console.log(`🔍 Attempting to save creative ${i + 1}:`, JSON.stringify(cleanedCreative, null, 2));
  
        const { data, error } = await supabase
          .from("creatives_duplicate")
          .insert([cleanedCreative])
          .select();
          
        if (error) {
          console.error(`❌ Creative ${i + 1} insert error:`, error);
          console.error("❌ Error details:", JSON.stringify(error, null, 2));
        } else {
          console.log(`✅ Creative ${i + 1} saved successfully.`);
          savedCreatives.push(data[0]);
        }
      }
  
      return {
        campaign_id,
        creatives: savedCreatives
      };
  
    } catch (err) {
      console.error("❌ Failed to save campaign and creatives:", err);
      throw err; // Re-throw to be caught by endpoint
    }
}

// MAIN ENDPOINT: End-to-end with Image Generation (FIXED VERSION)
app.post('/api/generate', async (req, res) => {
  const { campaignPrompt, generateImages = true } = req.body;
  
  if (!campaignPrompt) {
    return res.status(400).json({ error: "campaignPrompt is required" });
  }

  try {
    console.log("🔍 Starting generation for prompt:", campaignPrompt);
    
    // Step 1: Find similar creatives
    const similarCreatives = await findSimilarCampaigns(campaignPrompt);
    console.log(`✅ Found ${similarCreatives.length} similar creatives`);

    // Step 2: Generate creative directions using similar creatives
    const aiText = await generateCreativeDirections(campaignPrompt, similarCreatives);
    console.log("✅ Generated AI text:", aiText ? "Success" : "Failed");
    
    if (!aiText) {
      return res.status(500).json({ error: "Failed to generate creative directions" });
    }

    // Step 3: Save campaign and creatives
    const result = await saveCampaignPromptAndCreatives(campaignPrompt, aiText);
    console.log("✅ Save result:", result);

    // Step 4: Generate images if requested
    let imageResults = [];
    if (generateImages && process.env.REPLICATE_API_TOKEN && result.creatives.length > 0) {
      console.log("🎨 Starting image generation...");
      try {
        imageResults = await generateImagesForCreatives(result.creatives);
        console.log(`✅ Image generation completed: ${imageResults.length} results`);
      } catch (imageError) {
        console.error("❌ Image generation failed:", imageError.message);
        // Don't fail the whole request if image generation fails
      }
    }

    res.json({
      message: "Campaign and creatives saved.",
      campaign_id: result.campaign_id,
      creatives_count: result.creatives.length,
      creatives: result.creatives,
      similar_creatives_found: similarCreatives.length,
      image_results: imageResults,
      images_generated: imageResults.filter(r => r.success).length,
      aiText, // send raw AI output to see all 3 approaches
    });

  } catch (err) {
    console.error("❌ Error in /api/generate:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      details: err.message 
    });
  }
});

// New endpoint: Generate images for existing creatives
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