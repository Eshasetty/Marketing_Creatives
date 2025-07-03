// 📦 Required packages
const readlineSync = require('readline-sync');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
require('dotenv').config();

// 🔗 Supabase and OpenAI clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 💾 Save campaign prompt with embedding
async function saveCampaignPrompt(prompt) {
    try {
      // Generate embedding for the campaign prompt
      const embedding = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: prompt,
      });
  
      const { data, error } = await supabase
        .from('campaigns_duplicate') // 👈 Changed from 'campaigns' to 'campaigns_duplicate'
        .insert([
          { 
            campaign_prompt: prompt,
            embedding: embedding.data[0].embedding
          }
        ])
        .select();
  
      if (error) {
        console.error("❌ Failed to save campaign prompt:", error.message);
        return null;
      }
  
      console.log(`✅ Campaign prompt saved to 'campaigns_duplicate' with ID: ${data[0].campaign_id}`);
      return data[0].campaign_id;
    } catch (err) {
      console.error("❌ Error saving campaign prompt:", err.message);
      return null;
    }
  }
  

// 🔍 Find similar campaigns
async function findSimilarCampaigns(description) {
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: description,
      });
      const inputEmbedding = embeddingResponse.data[0].embedding;
  
      const { data: campaigns, error } = await supabase
        .from("campaigns")
        .select("campaign_id, campaign_prompt, embedding");
  
      if (error || !campaigns?.length) {
        console.log("⚠️ No campaigns found.");
        return { similarCampaigns: [], similarCreatives: [] };
      }
  
      const cosineSimilarity = (a, b) => {
        const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
        const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
        const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
        return (magA && magB) ? dot / (magA * magB) : 0;
      };
  
      const similarities = campaigns.map(c => {
        let emb = c.embedding;
        if (typeof emb === "string") {
          try { emb = JSON.parse(emb); } catch { return null; }
        }
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
  
      // Get matching campaign IDs
      const campaignIds = similarities.map(c => c.campaign_id);
  
      // Fetch corresponding creatives
      const { data: creatives, error: creativesError } = await supabase
        .from("creatives")
        .select("*")
        .in("campaign_id", campaignIds);
  
      if (creativesError) {
        console.error("⚠️ Failed to fetch creatives:", creativesError.message);
      }
  
      // Log results with metadata
      console.log(`\n✅ Top 3 similar campaigns:\n`);
      similarities.forEach((c, i) => {
        const creative = creatives?.find(cr => cr.campaign_id === c.campaign_id);
        console.log(`${i + 1}. "${c.campaign_prompt}" (${(c.similarity * 100).toFixed(2)}%)`);
  
        if (creative) {
          console.log(`   • Background: ${JSON.stringify(creative.background)}`);
          console.log(`   • Text Blocks: ${JSON.stringify(creative.text_blocks)}`);
          console.log(`   • CTA Buttons: ${JSON.stringify(creative.cta_buttons)}`);
          console.log(`   • Brand Colors: ${JSON.stringify(creative.brand_colors)}`);
          console.log(`   • Layout: ${creative.layout_grid}`);
        } else {
          console.log("   ⚠️ No creative metadata found.");
        }
  
        console.log();
      });
  
      return {
        similarCampaigns: similarities,
        similarCreatives: creatives || []
      };
    } catch (err) {
      console.error("❌ Error in findSimilarCampaigns:", err.message);
      return { similarCampaigns: [], similarCreatives: [] };
    }
  }
  
  
  

// 🖌️ Generate creative directions
// 📋 Generate 3 flexible creative directions
async function generateCreativeDirections(campaignPrompt, similarCreatives) {
    console.log("🎨 Generating 3 creative poster directions based on similar campaigns...");
  
    const similarInspirationText = similarCreatives.length > 0
      ? similarCreatives.slice(0, 3).map((c, i) => {
          return `CREATIVE ${i + 1}:
  - Background: ${JSON.stringify(c.background)}
  - Text Blocks: ${JSON.stringify(c.text_blocks)}
  - CTA Buttons: ${JSON.stringify(c.cta_buttons)}
  - Brand Colors: ${JSON.stringify(c.brand_colors)}
  - Layout: ${c.layout_grid}`;
        }).join("\n\n")
      : "No similar campaigns found. Create fresh but effective poster directions.";
  
    const messages = [
      {
        role: 'system',
        content: `You are a top-tier advertising creative director.
  
  Using the campaign description and inspirations, generate 3 complete creative poster directions.
  
  Each direction must:
  - Begin with "APPROACH 1:", etc.
  - Clearly list each element: Title, Subtitle, CTA Button, Background, Logo, etc.
  - Be inspired by the provided similar campaign components (CTAs, color palettes, structure, etc.)
  - Stick to the campaign’s **season** and **intent** (e.g. if it's a Spring sale, do NOT mention Black Friday)
  - Avoid placeholder or empty sections.
  - Each direction should have different tone, structure, or mood.
  - If the campaign sounds like a sale, clearance, or discount, clearly reflect that with strong promotional language.
  
  Output in this format, this is an exmaple, it doesnt have to be the same just use this structure but use the elements that are relevant to the campaign:
  
  APPROACH 1:
  - Title: ...
  - Subtitle: ...
  - Background: ...
  - Logo: where will the logo be placed
  - CTA Button: ...
  - Additional Text: ...
  
  Only include elements that help the creative, but **always include a logo**.`
      },
      {
        role: 'user',
        content: `Campaign Description: "${campaignPrompt}"
  
  Inspiration from similar campaigns:
  ${similarInspirationText}
  
  Generate 3 unique poster directions.`
      }
    ];
  
    try {
      const chat = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages,
        temperature: 0.85
      });
  
      return chat.choices[0].message.content.trim();
    } catch (err) {
      console.error("❌ Error generating poster directions:", err.message);
      return null;
    }
  }
  

// 🧠 Chat refinement loop
async function chatbotRefinement(prompt, initialPreview) {
  let current = initialPreview;
  while (true) {
    const input = readlineSync.question("\n💬 Feedback or request (or type 'done'): ");
    if (input.trim().toLowerCase() === 'done') break;

    const messages = [
      {
        role: 'system',
        content: `You're refining poster designs based on user feedback. Maintain the same format. Provide clear responses or updated versions if changes are requested.`
      },
      {
        role: 'user',
        content: `Original Campaign: ${prompt}\n\nCurrent Concepts:\n${current}\n\nUser Request: ${input}`
      }
    ];

    try {
      const chat = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages,
        temperature: 0.8
      });
      const reply = chat.choices[0].message.content.trim();
      console.log("\n🎨 " + reply);
      if (reply.includes("APPROACH")) current = reply;
    } catch (err) {
      console.error("❌ Error during refinement:", err.message);
    }
  }
  return current;
}

// 🚀 Entry point
async function main() {
  console.log("🎨 Welcome to the Strategic Poster AI Assistant");

  const description = readlineSync.question("📝 What's your poster campaign about? ");
  const brand = readlineSync.question("🏷️  Brand name? ");

  const { similarCampaigns, similarCreatives } = await findSimilarCampaigns(description);

  const preview = await generateCreativeDirections(description, similarCreatives);
  if (preview) {
    console.log("\n" + "=".repeat(80));
    console.log("🎨 CREATIVE POSTER CONCEPTS");
    console.log("=".repeat(80));
    console.log(preview);
    console.log("=".repeat(80));
  }

  await saveCampaignPrompt(description);
  await chatbotRefinement(description, preview);

  console.log("\n✅ Campaign finalized and saved. Goodbye!");
}

main().catch(console.error);