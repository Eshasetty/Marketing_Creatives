// server.js (Updated with Image Generation)

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

// Util: Cosine similarity
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return (magA && magB) ? dot / (magA * magB) : 0;
}

// STEP 1: Find similar creatives
async function findSimilarCreatives(prompt) {
    const embeddingRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: prompt,
    });
    const inputEmbedding = embeddingRes.data[0].embedding;
    console.log("🔢 Input embedding length:", inputEmbedding.length);
  
    const { data: campaigns, error } = await supabase
      .from("campaigns_duplicate")
      .select("campaign_id, campaign_prompt, embedding");
  
    if (error || !campaigns?.length) {
      console.error("❌ Failed to fetch campaigns or none found.");
      return [];
    }
  
    console.log(`📦 Comparing against ${campaigns.length} stored campaigns...`);
  
    const comparisons = [];
  
    const similarities = campaigns.map((c, i) => {
      let emb;
      try {
        emb = typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding;
      } catch (err) {
        console.warn(`❌ Campaign ${c.campaign_id}: Failed to parse embedding.`);
        return null;
      }
  
      if (!Array.isArray(emb) || emb.length !== inputEmbedding.length) {
        console.warn(`⚠️ Campaign ${c.campaign_id}: Invalid or mismatched embedding size.`);
        return null;
      }
  
      const sim = cosineSimilarity(inputEmbedding, emb);
      comparisons.push({ id: c.campaign_id, similarity: sim });
      console.log(`🔍 Campaign ${c.campaign_id} → Similarity: ${sim.toFixed(4)}`);
  
      return { ...c, similarity: sim };
    })
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);
  
    if (similarities.length === 0) {
      console.warn("⚠️ No similar campaigns found above threshold or due to data issues.");
    } else {
      console.log("🏆 Top 3 Similar Campaigns:");
      similarities.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.campaign_id} → ${s.similarity.toFixed(4)}`);
      });
    }
  
    const campaignIds = similarities.map(c => c.campaign_id);
  
    const { data: creatives } = await supabase
      .from("creatives_duplicate")
      .select("*")
      .in("campaign_id", campaignIds);
  
    return creatives || [];
  }
  

// STEP 2: Generate creative directions
async function generateCreativeDirections(campaignPrompt, similarCreatives = []) {
    try {
      // 1. Get similar creatives from Supabase
      const similarCreatives = await findSimilarCreatives(campaignPrompt);
  
      // 2. Format them as a reference block for the GPT message
      const similarCreativeText = similarCreatives.length
        ? similarCreatives.map((c, i) => {
            return `Similar Creative ${i + 1}:\n` +
                   `Title: ${c.title || ''}\n` +
                   `Subtitle: ${c.subtitle || ''}\n` +
                   `Background Description: ${c.background_description || ''}\n` +
                   `Layout: ${c.layout || ''}\n` +
                   `Placement: ${c.placement || ''}\n` +
                   `Format: ${c.format || ''}\n` +
                   `CTA Button: ${c.cta_button || ''}`;
          }).join('\n\n')
        : 'No similar creatives found.';
  
      // 3. Build prompt with both the campaign and similar examples
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content: `
  You are a creative assistant for ad design.
  
  Return 3 unique creative approaches using the exact format below. Use all fields. You may repeat fields like CTA or Subtitle if needed. If something doesn’t apply, leave it blank.
  
    In the Background Description:
    - Do NOT use mood words like “inviting,” “urgent,” or “exclusive”
    - ONLY describe what visually appears: people, locations, objects, colors, textures, composition, lighting, style (e.g. realistic, flat)
    - Match the style of the similar creatives. If similar campaigns used solid or minimal backgrounds, do the same. Only add imagery if it was clearly present in the referenced examples.
    - Make sure it is not too crowded because it will be used as a background.

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
  
  Here are 3 similar creatives from past campaigns for inspiration:
  ${similarCreativeText}
            `.trim()
          }
        ]
      });
  
      return completion.choices[0].message.content;
    } catch (error) {
      console.error("❌ Error generating creative directions:", error.message);
      return null;
    }
  }
  

// STEP 3: Save campaign and creatives (Updated)
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

// MAIN ENDPOINT: End-to-end with Image Generation
app.post('/api/generate', async (req, res) => {
    const { campaignPrompt, generateImages = true } = req.body;
    if (!campaignPrompt) return res.status(400).json({ error: "campaignPrompt is required" });
  
    try {
      console.log("🔍 Starting generation for prompt:", campaignPrompt);
      
      const similarCreatives = await findSimilarCreatives(campaignPrompt);
        console.log("✅ Found similar creatives:", similarCreatives.length);

        const aiText = await generateCreativeDirections(campaignPrompt, similarCreatives); // ✅ Pass them here

      console.log("✅ Generated AI text:", aiText ? "Success" : "Failed");
      
      if (!aiText) {
        return res.status(500).json({ error: "Failed to generate creative directions" });
      }
  
      const result = await saveCampaignPromptAndCreatives(campaignPrompt, aiText);
      console.log("✅ Save result:", result);

      // Generate images if requested and API token is available
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