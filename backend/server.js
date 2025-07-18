// server.js - Rewritten for Selective RAG

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { generateImagesForCreatives, extractBackgroundDescription, extractPosterDescription, parseDynamicAiText, parseSectionedAiText } = require('./imageGenerator'); // Assuming this file exists
require('dotenv').config();
const router = express.Router();

const app = express();
const port = process.env.PORT || 4000;

// --- Environment Variable Checks ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.OPENAI_API_KEY) {
  console.error("❌ Critical Error: Missing environment variables (SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY). Please check your .env file.");
  process.exit(1);
}

if (!process.env.REPLICATE_API_TOKEN) {
  console.warn("⚠️ Warning: REPLICATE_API_TOKEN not found. Image generation functionality will be disabled.");
}

// --- Supabase and OpenAI Client Initialization ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Utility Functions ---

/**
 * Calculates the cosine similarity between two vectors.
 * @param {number[]} a - First vector.
 * @param {number[]} b - Second vector.
 * @returns {number} The cosine similarity, or 0 if inputs are invalid.
 */
function cosineSimilarity(a, b) {
  try {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      console.error("CosineSimilarity Error: Inputs must be arrays.");
      return 0;
    }
    
    if (a.length !== b.length) {
      console.error("CosineSimilarity Error: Arrays must have the same length.");
      return 0;
    }

    const dot = a.reduce((sum, val, i) => sum + (val * b[i]), 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + (val * val), 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + (val * val), 0));
    
    if (magA === 0 || magB === 0) {
      return 0; // Avoid division by zero
    }
    
    const similarity = dot / (magA * magB);
    
    // Ensure result is between -1 and 1
    return Math.max(-1, Math.min(1, similarity));
  } catch (error) {
    console.error("Error in cosineSimilarity:", error);
    return 0;
  }
}

/**
 * Retrieves inspiration creatives for RAG, either by specific user selection
 * or by semantic similarity to a given description.
 * @param {string} description - The primary text description for semantic search fallback.
 * @param {string[]} selectedCreativeIds - Optional array of creative_ids selected by the user.
 * @returns {Promise<Array<Object>>} An array of creative objects formatted for RAG context.
 */
async function getInspirationCreatives(description, selectedCreativeIds = []) {
    try {
        let creativesForRAG = [];

        // --- Option 1: User provided specific creative IDs ---
        if (selectedCreativeIds.length > 0) {
            console.log(`🎯 Attempting to retrieve user-selected creatives for RAG: [${selectedCreativeIds.join(', ')}]`);
            const { data, error } = await supabase
                .from("creatives") // Your creatives table
                .select("*") // Select all details for RAG context building
                .in("creative_id", selectedCreativeIds);

            if (error) {
                console.error("⚠️ Error fetching selected creatives by ID from Supabase:", error.message);
                // Continue to semantic search as a fallback if explicit fetch fails
            } else if (data && data.length > 0) {
                // Map the fetched creative data to the expected format for generateCreativeDirections
                creativesForRAG = data.map(c => ({
                    creative: c,
                    campaign_prompt: `User Selected Creative ID: ${c.creative_id}`, // Placeholder or fetch actual campaign prompt if available
                    similarity: 1.0 // Assign high similarity as they were explicitly selected
                }));
                console.log(`✅ Successfully retrieved ${creativesForRAG.length} user-selected creatives for inspiration.`);
                return creativesForRAG; // Return immediately if specific creatives are found
            }
            console.warn("⚠️ No valid creatives found for the provided IDs. Falling back to semantic search for inspiration.");
        }

        // --- Option 2 (Fallback or Default): Semantic search for similar campaigns ---
        console.log("🔍 No specific creatives selected or selection failed. Performing semantic search for inspiration...");

        // 1. Embed the input description
        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small", // Using text-embedding-3-small
            input: description,
        });
        const inputEmbedding = embeddingResponse.data[0].embedding;
  
        // 2. Fetch existing campaigns with their embeddings
        const { data: campaigns, error: campaignError } = await supabase
            .from("campaigns_duplicate") // Your campaigns table with embeddings
            .select("campaign_id, campaign_prompt, embedding");
  
        if (campaignError || !campaigns?.length) {
            console.warn("⚠️ No campaigns found in Supabase for semantic search or error fetching.");
            return [];
        }
  
        // 3. Calculate similarities
        const similarities = campaigns.map(c => {
            let emb = typeof c.embedding === "string" ? JSON.parse(c.embedding) : c.embedding;
            if (!Array.isArray(emb)) {
                console.warn(`Skipping campaign ${c.campaign_id} due to invalid embedding format.`);
                return null;
            }
            return { ...c, similarity: cosineSimilarity(inputEmbedding, emb) };
        }).filter(Boolean) // Filter out nulls from invalid embeddings
          .filter(c => c.similarity > 0.2) // Filter by your desired similarity threshold
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 5); // Get top 5 most similar campaigns for more inspiration
  
        if (!similarities.length) {
            console.log("📉 No similar campaigns found above threshold via semantic search.");
            return [];
        }
  
        // 4. Get corresponding creatives for the semantically similar campaigns
        const campaignIds = similarities.map(c => c.campaign_id);
  
        const { data: creatives, error: creativesError } = await supabase
            .from("creatives") // Your creatives table
            .select("*") // Select all details for RAG context
            .in("campaign_id", campaignIds);
  
        if (creativesError) {
            console.error("⚠️ Error fetching creatives for similar campaigns:", creativesError.message);
            return [];
        }
  
        // 5. Combine similar campaigns with their creatives for the final RAG context
        creativesForRAG = similarities.map(campaign => {
            const creative = creatives?.find(cr => String(cr.campaign_id) === String(campaign.campaign_id));
            return creative ? {
                ...campaign, // Contains campaign_id, campaign_prompt, embedding, similarity
                creative: creative // The full creative object
            } : null; // Only include if a matching creative is found
        }).filter(item => item !== null); // Remove campaigns for which no creative was found
  
        console.log(`✅ Will use ${creativesForRAG.length} semantically similar creatives as inspiration.`);
        return creativesForRAG;
  
    } catch (err) {
        console.error("❌ Error in getInspirationCreatives:", err.message);
        return [];
    }
}
  
/**
 * Generates a new creative direction using a campaign prompt and optional similar creatives as inspiration.
 * @param {string} campaignPrompt - The user's input campaign prompt.
 * @param {Array<Object>} similarCreatives - An array of creative objects to use as inspiration for the LLM.
 * @returns {Promise<string|null>} The generated AI text for the creative direction, or null if an error occurs.
 */
async function generateCreativeDirections(campaignPrompt, similarCreatives = []) {
  try {
    console.log(`🎯 Generating creative direction using ${similarCreatives.length} similar creatives as inspiration.`);

    // Format similar creatives for the prompt sent to the LLM
    const similarCreativeText = similarCreatives.length > 0
      ? similarCreatives.map((item, i) => {
          const c = item.creative;
          return `Similar Creative ${i + 1} (Similarity: ${(item.similarity * 100).toFixed(1)}%):\n` +
                 `Campaign Prompt: "${item.campaign_prompt}"\n` +
                 `Title: ${c.text_blocks?.[0]?.text || 'N/A'}\n` +
                 `Subtitle: ${c.text_blocks?.[1]?.text || 'N/A'}\n` +
                 `Background: Type: ${c.background?.type || 'N/A'}, Description: ${c.background?.description || c.background?.color || 'N/A'}\n` +
                 `Layout: ${c.layout_grid || 'N/A'}\n` +
                 `Placement: ${c.placement || 'N/A'}\n` +
                 `Format: ${c.format || 'N/A'}\n` +
                 `CTA Button Text: ${c.cta_buttons?.[0]?.text || 'N/A'}\n` +
                 `Slogan: ${c.slogan || 'N/A'}`;
        }).join('\n\n')
      : 'No specific similar creatives provided. Create an original and compelling ad concept.';

    console.log("📝 Similar creatives context being sent to LLM:\n", similarCreativeText);

    // Build the user message for the LLM
    let userMessage = `Here is a campaign prompt:\n${campaignPrompt}\n\n` +
                      `Here are details of past creatives to use as inspiration. Generate ONE new, unique creative approach inspired by ALL of these, or create an original one if no inspiration is provided:\n` +
                      `${similarCreativeText}`;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // You might consider gpt-4 or gpt-4o for better quality
      temperature: 0.7, // Balances creativity and adherence to instructions
      messages: [
        {
          role: "system",
          content: `
You are a creative assistant for ad design, specializing in poster ads for brands like Hollister.
Your task is to generate ONE comprehensive creative approach based on the user's campaign prompt and any provided similar creative inspirations.
Strictly adhere to the output format provided below. Ensure all fields are present. If a field does not apply or no information is available, leave its value blank or use "N/A" where appropriate, but do not omit the field name itself.

In the 'Background Description' field:
- ONLY describe what visually appears: people, locations, objects, colors, textures, composition, lighting, style (e.g., realistic, flat, abstract).
- Do NOT use subjective mood words like "inviting", "urgent", "exclusive", "vibrant", etc.
- If similar creatives are provided, try to match their visual style (e.g., photo backgrounds with people/scenery, solid colors, abstract shapes).
- Prioritize clear, concise descriptions. Avoid overly cluttered or busy backgrounds.

For 'Dimensions', if not explicitly inferable from the prompt or inspiration, use a standard mobile portrait format like '1080x1920'.
For 'Font Family', if not specified, default to a clean, modern sans-serif like 'Inter', 'Roboto', or 'Open Sans'.
For 'Font Weight', default to '400' if not specified.
For 'Color' fields (text, background, decorative), use standard hex codes (e.g., '#FFFFFF').

Ensure the text for 'Title', 'Subtitle', and 'CTA' is direct and aligns with the campaign prompt and inspiration.
For 'Layout', choose from: [free / 2-col / 3-col / golden-ratio].
For 'Format', choose from: [static / gif / video / html5].
For 'Placement', choose from common ad placements like: [homepage / email / app / social / display].
For 'Decorative Element', consider simple shapes like: [line / blob / sticker / none].

Output the creative approach using this EXACT format:

Title
text: [main headline]
font: [font family]
weight: [font weight]
color: [hex]
alignment: [left / center / right]
case: [sentence / upper / title]

Subtitle 1
text: [subheadline]
font: [font family]
weight: [font weight]
color: [hex]
alignment: [left / center / right]
case: [sentence / upper / title]

Slogan
text: [brand slogan or tag line]
Legal Disclaimer:
text: [optional legal text, if applicable]

CTA
text: [CTA button text, e.g., Shop Now, Learn More]
url: [CTA target URL, e.g., https://example.com/shop]
style: [primary / secondary / ghost]
bg_color: [hex]
text_color: [hex]

Background
type: [photo / solid / gradient / textured]
color: [hex]
description: [detailed visual description of the background]
Branding:
logo_alt_text: Hollister [or other brand]

Layout
type: [free / 2-col / 3-col / golden-ratio]
placement: [homepage / email / app / social / display]
format: [static / gif / video / html5]
dimensions: [width]x[height]

Decorative Element:
shape: [line / blob / sticker / none]
color: [hex]

Only return the "APPROACH:" block and its content. No preambles, no explanations, no extra dialogue.
          `.trim()
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const result = completion.choices[0].message.content;
    console.log("✅ Creative direction generated successfully by LLM.");
    return result;

  } catch (error) {
    console.error("❌ Error generating creative directions with LLM:", error);
    return null;
  }
}

/**
 * Saves the campaign prompt and the generated creative data to Supabase.
 * It also handles parsing the AI text into a structured JSON object for the database.
 * @param {string} prompt - The original campaign prompt.
 * @param {string} aiText - The raw AI-generated creative approach text.
 * @returns {Promise<Object>} An object containing the campaign_id and the saved creative object.
 */
/**
 * Updated function to save campaign and creatives using the new structured parser
 */
async function saveCampaignPromptAndCreatives(prompt, aiText) {
    try {
        // Step 1: Embed the original campaign prompt
        console.log("Embedding campaign prompt for storage...");
        const embeddingRes = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: prompt,
        });
        const embedding = embeddingRes.data[0].embedding;
        console.log("Prompt embedded successfully.");

        // Step 2: Save the campaign prompt and its embedding
        const { data: campaignInsert, error: campaignError } = await supabase
            .from("campaigns_duplicate")
            .insert([{ campaign_prompt: prompt, embedding }])
            .select();

        if (campaignError) {
            console.error("❌ Supabase Campaign Insert Error:", campaignError);
            throw campaignError;
        }

        const campaign_id = campaignInsert[0].campaign_id;
        console.log(`✅ Campaign saved with ID: ${campaign_id}`);

        // Step 3: Parse AI output using the robust structured parser
        console.log("Parsing AI-generated creative text with structured parser...");
        const creative = parseStructuredAIText(aiText);
        creative.campaign_id = campaign_id;

        // Clean undefined values
        const cleanedCreative = JSON.parse(JSON.stringify(creative, (key, value) =>
            value === undefined ? null : value
        ));

        console.log(`🔍 Attempting to save parsed creative data to Supabase:`);
        const { data, error } = await supabase
            .from("creatives_duplicate")
            .insert([cleanedCreative])
            .select();

        if (error) {
            console.error(`❌ Supabase Creative Insert Error:`, error);
            console.error("❌ Supabase Error details:", JSON.stringify(error, null, 2));
            throw error;
        } else {
            console.log(`✅ Creative saved successfully with ID: ${data[0].creative_id}`);
            return {
                campaign_id,
                creative: data[0]
            };
        }

    } catch (err) {
        console.error("❌ Failed to save campaign and creative to database:", err);
        throw err;
    }
}

// --- API Endpoints ---
app.post("/api/previous-creatives", async (req, res) => {
  try {
    console.log("➡️ Request to fetch previous creatives' imagery URLs.");
    const { data, error } = await supabase
      .from("creatives_duplicate")
      .select("imagery");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const urls = data
      .map(row => Array.isArray(row.imagery) && row.imagery[1])
      .filter(Boolean);

    res.status(200).json({ urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Endpoint to fetch all existing creatives for user selection display
app.get('/api/creatives', async (req, res) => {
  try {
    console.log("➡️ Request to fetch all creatives for display.");
    const { data, error } = await supabase
      .from("creatives") // Or your main creatives table
      .select("creative_id, campaign_id, text_blocks, background, imagery, slogan"); // Select necessary fields for display

    if (error) {
        console.error("❌ Error fetching creatives for display:", error.message);
        throw error;
    }
    if (!data || data.length === 0) {
        console.log("ℹ️ No creatives found in the database.");
        return res.json([]);
    }

    // Enhance data for frontend: Add simplified descriptions and image URLs
    const enhancedCreatives = data.map(creative => {
      const title = creative.text_blocks?.[0]?.text || '';
      const subtitle = creative.text_blocks?.[1]?.text || '';
      const backgroundDesc = creative.background?.description || creative.background?.color || creative.background?.type || '';
      const imageUrl = creative.imagery?.[0]?.url || null; // Assuming imagery is an array of objects with a 'url' key

      return {
        creative_id: creative.creative_id,
        campaign_id: creative.campaign_id,
        title: title,
        subtitle: subtitle,
        background_description: backgroundDesc,
        image_url: imageUrl,
        simplified_text_for_display: `${title} ${subtitle} ${backgroundDesc} ${creative.slogan || ''}`.trim()
      };
    });

    console.log(`✅ Successfully fetched ${enhancedCreatives.length} creatives for display.`);
    res.json(enhancedCreatives);

  } catch (err) {
    console.error("❌ Internal Server Error in /api/creatives:", err.message);
    res.status(500).json({
      error: "Internal Server Error",
      details: err.message
    });
  }
});

// MAIN ENDPOINT: Generate initial creative approach (with Selective RAG)
app.post('/api/generate', async (req, res) => {
  const { campaignPrompt, selectedCreativeIds = [] } = req.body; // Expect campaignPrompt and optional selectedCreativeIds
  
  console.log("THIS FILE IS RUNNING");

  if (!campaignPrompt) {
    return res.status(400).json({ error: "campaignPrompt is required for generation." });
  }

  try {
    console.log(`➡️ Request to generate creative for prompt: "${campaignPrompt}". Selected IDs: ${selectedCreativeIds.length > 0 ? selectedCreativeIds.join(', ') : 'None'}`);
    
    // Step 1: Retrieve inspiration creatives (either user-selected or semantically similar)
    const creativesForInspiration = await getInspirationCreatives(campaignPrompt, selectedCreativeIds);
    console.log(`✅ ${creativesForInspiration.length} creatives retrieved for inspiration context.`);

    // Step 2: Generate creative direction using the LLM with the gathered inspiration
    const aiText = await generateCreativeDirections(campaignPrompt, creativesForInspiration);
    
    if (!aiText) {
      console.error("❌ Failed to get AI text for creative direction.");
      return res.status(500).json({ error: "Failed to generate creative direction from AI." });
    }

    console.log("✅ Creative generation process completed.");
    res.json({
      message: "Creative approach generated successfully. Review and modify if needed.",
      aiText,
      creatives_used_for_rag: creativesForInspiration.length, // Report how many were used
      ready_to_save: true // Indicate that the response is ready for saving
    });

  } catch (err) {
    console.error("❌ Unhandled Error in /api/generate endpoint:", err);
    res.status(500).json({ 
      error: "Internal Server Error during creative generation", 
      details: err.message 
    });
  }
});

// NEW ENDPOINT: Modify the generated approach (client-side AI iteration)
app.post('/api/modify', async (req, res) => {
  const { originalAiText, modifications } = req.body;
  
  if (!originalAiText || !modifications) {
    return res.status(400).json({ error: "originalAiText and modifications are required for modification." });
  }

  try {
    console.log("➡️ Request to modify existing creative approach based on user input.");
    console.log("🔄 User modification request:", modifications);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Consider gpt-4 for more nuanced modifications
      temperature: 0.7, // Keep creativity balanced
      messages: [
        {
          role: "system",
          content: `
You are a creative assistant for ad design, specifically for modifying existing creative approaches.
Your task is to apply the requested modifications to the provided 'Existing Creative Approach' while strictly maintaining the original output format.
Only change the fields that are explicitly mentioned or implied by the modifications.
If the user requests a NEW element that wasn't in the original, add it to the end of the 'APPROACH:' block following the established subcategory format.
Ensure all fields from the original format are still present in your modified output, even if their values remain unchanged.

Always return the modified approach using this EXACT format:


Title
text: [main headline]
font: [font family]
weight: [font weight]
color: [hex]
alignment: [left / center / right]
case: [sentence / upper / title]

Subtitle 1
text: [subheadline]
font: [font family]
weight: [font weight]
color: [hex]
alignment: [left / center / right]
case: [sentence / upper / title]

Slogan
text: [brand slogan or tag line]
Legal Disclaimer:
text: [optional legal text, if applicable]

CTA
text: [CTA button text, e.g., Shop Now, Learn More]
url: [CTA target URL, e.g., https://example.com/shop]
style: [primary / secondary / ghost]
bg_color: [hex]
text_color: [hex]

Background
type: [photo / solid / gradient / textured]
color: [hex]
description: [detailed visual description of the background]
Branding:
logo_alt_text: Hollister [or other brand]

Layout
type: [free / 2-col / 3-col / golden-ratio]
placement: [homepage / email / app / social / display]
format: [static / gif / video / html5]
dimensions: [width]x[height]

Decorative Element:
shape: [line / blob / sticker / none]
color: [hex]

Only return the "APPROACH:" block and its content. No preambles, no explanations, no extra dialogue.
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
      console.error("❌ LLM failed to generate modified creative direction.");
      return res.status(500).json({ error: "Failed to generate modified creative direction from AI." });
    }

    console.log("✅ Creative approach modified successfully.");
    res.json({
      message: "Creative approach modified successfully.",
      aiText: result, // Return the modified AI text
      modifications_applied: modifications,
      ready_to_save: true
    });

  } catch (err) {
    console.error("❌ Unhandled Error in /api/modify endpoint:", err);
    res.status(500).json({ 
      error: "Internal Server Error during modification", 
      details: err.message 
    });
  }
});

// NEW ENDPOINT: Save the finalized approach and potentially generate images
const axios = require('axios'); // Make sure to install: npm install axios

app.post('/api/save', async (req, res) => {
    const { campaignPrompt, aiText, generateImages = true, generateFullCreative = false } = req.body;
  
    if (!campaignPrompt || !aiText) {
      return res.status(400).json({ error: "campaignPrompt and aiText are required to save." });
    }
  
    try {
      console.log("➡️ Request to save finalized creative approach.");
  
      // Step 1: Save campaign and creative to DB
      const saveResult = await saveCampaignPromptAndCreatives(campaignPrompt, aiText);
      console.log("✅ Creative data saved to database. Ready for image generation.");
  
      let imageResults = [];
      let posterUrl = null;
      let fullCreativeResults = null;
  
      // Step 2: Generate images if enabled
      if (generateImages && process.env.REPLICATE_API_TOKEN && saveResult.creative) {
        console.log("🎨 Initiating image generation for the saved creative...");
  
        const creativeForImageGen = {
          creative_id: saveResult.creative.creative_id,
          aiText: aiText
        };
  
        try {
          imageResults = await generateImagesForCreatives([creativeForImageGen]);
          console.log(`✅ Image generation completed: ${imageResults.length} results.`);
  
          // ✅ Extract poster URL from returned imageResults
          const firstResult = imageResults[0];
          if (firstResult && firstResult.savedImageryData) {
            const posterImage = firstResult.savedImageryData.find(img => img.type === "poster" && img.url);
            if (posterImage) {
              posterUrl = posterImage.url;
              console.log("✅ Poster image URL extracted:", posterUrl);
            } else {
              console.warn("⚠️ No poster image found in savedImageryData.");
            }
          }
  
        } catch (imageError) {
          console.error("❌ Image generation failed:", imageError.message);
          imageResults = [{
            success: false,
            error: `Image generation failed: ${imageError.message}`,
            creative_id: saveResult.creative.creative_id
          }];
        }
      } else if (!generateImages) {
        console.log("ℹ️ Image generation skipped by client.");
      } else if (!process.env.REPLICATE_API_TOKEN) {
        console.warn("⚠️ Missing REPLICATE_API_TOKEN, skipping image generation.");
      } else if (!saveResult.creative) {
        console.warn("⚠️ No creative returned from save operation.");
      }

      // Step 3: Generate full creative HTML via HTTP request
      if (saveResult.creative && saveResult.creative.creative_id) {
        console.log("🎨 Initiating full creative generation via HTTP request...");
        
        try {
   
          const fullCreativeApiUrl = `http://localhost:3001/api/generate-full-creative`;
          
          console.log(`📡 Making HTTP request to: ${fullCreativeApiUrl}`);
          console.log(`📋 Request payload: { creative_id: ${saveResult.creative.creative_id} }`);
          
          // Make the HTTP POST request
          const response = await axios.post(fullCreativeApiUrl, {
            creative_id: saveResult.creative.creative_id
          }, {
            headers: {
              'Content-Type': 'application/json',
              // Add any authentication headers if needed
              // 'Authorization': `Bearer ${process.env.API_TOKEN}`,
            },
          });
          
          fullCreativeResults = response.data;
          console.log("✅ Full creative generation completed successfully via HTTP request.");
          console.log(`📊 Response keys: ${Object.keys(fullCreativeResults).join(', ')}`);
          
        } catch (fullCreativeError) {
          console.error("❌ Full creative generation HTTP request failed:", fullCreativeError.message);
          
          // Handle different types of errors
          if (fullCreativeError.response) {
            // Server responded with error status
            console.error("❌ Error response status:", fullCreativeError.response.status);
            console.error("❌ Error response data:", fullCreativeError.response.data);
            
            fullCreativeResults = {
              success: false,
              error: `Full creative generation failed: ${fullCreativeError.response.data?.error || fullCreativeError.message}`,
              status: fullCreativeError.response.status
            };
          } else if (fullCreativeError.request) {
            // Request was made but no response received
            console.error("❌ No response received from full creative API");
            fullCreativeResults = {
              success: false,
              error: "Full creative generation failed: No response from API"
            };
          } else {
            // Something else happened
            fullCreativeResults = {
              success: false,
              error: `Full creative generation failed: ${fullCreativeError.message}`
            };
          }
        }
      } else if (!generateFullCreative) {
        console.log("ℹ️ Full creative generation skipped by client.");
      } else if (!saveResult.creative || !saveResult.creative.creative_id) {
        console.warn("⚠️ No creative ID available for full creative generation.");
      }
  
      // ✅ Final response
      res.json({
        message: "Campaign and creative saved successfully.",
        campaign_id: saveResult.campaign_id,
        creative: saveResult.creative,
        poster_url: posterUrl,
        image_generation_status: !!posterUrl,
        image_results: imageResults,
        full_creative_results: fullCreativeResults,
        full_creative_generated: !!fullCreativeResults && fullCreativeResults.success !== false,
        aiText: aiText
      });
  
    } catch (err) {
      console.error("❌ Unhandled Error in /api/save endpoint:", err);
      res.status(500).json({
        error: "Internal Server Error during save operation",
        details: err.message
      });
    }
});
  

function parseStructuredAIText(aiText) {
    const approachText = aiText.replace(/^APPROACH:?\s*/i, '').trim();
    const lines = approachText.split("\n").map(l => l.trim()).filter(Boolean);
    
    // Enhanced helper to parse structured fields
    const parseStructuredField = (lines, sectionName, fieldName) => {
        // Find the section header, with or without a colon
        const sectionIndex = lines.findIndex(l => {
            const normalized = l.toLowerCase().replace(/:$/, '').trim();
            return normalized === sectionName.toLowerCase();
        });
        if (sectionIndex === -1) return null;

        // Look for the field within the next few lines after the section
        for (let i = sectionIndex + 1; i < Math.min(sectionIndex + 10, lines.length); i++) {
            const line = lines[i].toLowerCase();
            if (line.startsWith(fieldName.toLowerCase() + ":")) {
                return lines[i].split(":").slice(1).join(":").trim();
            }
            // Stop if we hit another section header (with or without colon)
            if (/^[a-z ]+:?$/i.test(lines[i])) break;
        }
        return null;
    };
    
    // Parse dimensions safely
    const dimensionsStr = parseStructuredField(lines, "Layout", "dimensions");
    const widthHeight = dimensionsStr?.split("x").map(x => parseInt(x.trim()));
    const dimensions = (widthHeight?.length === 2 && !isNaN(widthHeight[0]) && !isNaN(widthHeight[1]))
        ? { width: widthHeight[0], height: widthHeight[1] }
        : { width: 1080, height: 1920 };

    // Parse font weight safely
    const fontWeightStr = parseStructuredField(lines, "Title", "weight");
    const fontWeight = parseInt(fontWeightStr);
    const safeFontWeight = !isNaN(fontWeight) ? fontWeight : 400;

    // Validate layout_grid
    const rawLayout = parseStructuredField(lines, "Layout", "type")?.toLowerCase() || "free";
    const validLayouts = ["free", "2-col", "3-col", "golden-ratio"];
    const layout_grid = validLayouts.includes(rawLayout) ? rawLayout : "free";

    // Validate format
    const rawFormat = parseStructuredField(lines, "Layout", "format")?.toLowerCase() || "static";
    const validFormats = ["static", "gif", "video", "html5"];
    const format = validFormats.includes(rawFormat) ? rawFormat : "static";

    // Parse background
    const backgroundType = parseStructuredField(lines, "Background", "type")?.toLowerCase() || "solid";
    const validBackgroundTypes = ["photo", "solid", "gradient", "textured"];
    const backgroundFinalType = validBackgroundTypes.includes(backgroundType) ? backgroundType : "solid";

    // Construct text blocks
    const textBlocks = [
        {
            type: "headline",
            text: parseStructuredField(lines, "Title", "text") || "",
            font_family: parseStructuredField(lines, "Title", "font") || "Inter",
            font_weight: safeFontWeight,
            color: parseStructuredField(lines, "Title", "color") || "#000000",
            alignment: parseStructuredField(lines, "Title", "alignment") || "center",
            case_style: parseStructuredField(lines, "Title", "case") || "sentence"
        },
        {
            type: "subhead",
            text: parseStructuredField(lines, "Subtitle 1", "text") || "",
            font_family: parseStructuredField(lines, "Subtitle 1", "font") || "Inter",
            font_weight: parseInt(parseStructuredField(lines, "Subtitle 1", "weight")) || 400,
            color: parseStructuredField(lines, "Subtitle 1", "color") || "#000000",
            alignment: parseStructuredField(lines, "Subtitle 1", "alignment") || "center",
            case_style: parseStructuredField(lines, "Subtitle 1", "case") || "sentence"
        }
    ];

    // Construct CTA buttons
    const ctaButtons = [{
        text: parseStructuredField(lines, "CTA", "text") || "Shop Now",
        url: parseStructuredField(lines, "CTA", "url") || "https://example.com",
        style: parseStructuredField(lines, "CTA", "style")?.toLowerCase() || "primary",
        bg_color: parseStructuredField(lines, "CTA", "bg_color") || "#007bff",
        text_color: parseStructuredField(lines, "CTA", "text_color") || "#ffffff"
    }];

    // Construct decorative elements
    const decorativeElementShape = parseStructuredField(lines, "Decorative Element", "shape")?.toLowerCase() || "none";
    const validDecorativeShapes = ["line", "blob", "sticker", "none"];
    const decorativeElements = [{
        shape_type: validDecorativeShapes.includes(decorativeElementShape) ? decorativeElementShape : "none",
        color: parseStructuredField(lines, "Decorative Element", "color") || "#cccccc"
    }];

    // *** FIX: Initialize imagery array with placeholders for background and full poster ***
    const imagery = [
        {
            type: "background",
            url: null, // Will be populated by image generation
            alt_text: "Generated background image",
            status: "pending"
        },
        {
            type: "full_poster",
            url: null, // Will be populated by image generation
            alt_text: "Generated full poster image",
            status: "pending"
        }
    ];

    return {
        placement: parseStructuredField(lines, "Layout", "placement") || "social",
        dimensions,
        format,
        background: {
            color: parseStructuredField(lines, "Background", "color") || "#ffffff",
            type: backgroundFinalType,
            description: parseStructuredField(lines, "Background", "description") || ""
        },
        layout_grid,
        bleed_safe_margins: null,
        imagery: imagery, 
        text_blocks: textBlocks,
        cta_buttons: ctaButtons,
        brand_logo: {
            text_alt: parseStructuredField(lines, "Branding", "logo_alt_text") || "Brand Logo"
        },
        brand_colors: [],
        slogan: parseStructuredField(lines, "Slogan", "text") || null,
        legal_disclaimer: parseStructuredField(lines, "Legal Disclaimer", "text") || null,
        decorative_elements: decorativeElements
    };
}

// --- Server Start ---
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`Environment variables loaded. Supabase URL: ${process.env.SUPABASE_URL ? 'Loaded' : 'Not Loaded'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Loaded' : 'Not Loaded'}`);
});