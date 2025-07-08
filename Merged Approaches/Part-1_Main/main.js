// main.js

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const { spawn } = require("child_process");
const path = require("path");
const fetch = require("node-fetch"); // Ensure node-fetch is imported if not using Node 18+ native fetch

// Import the consolidated image generation function from the new file name
const { generateImagesForCreatives } = require("./BackgroundGenerator.js");

// Load environment variables
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3001;

// --- Environment Variable Checks ---
if (
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_KEY ||
  !process.env.OPENAI_API_KEY
) {
  console.error(
    "❌ Missing essential environment variables (SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY)."
  );
  process.exit(1);
}
// Ensure REPLICATE_API_TOKEN is also set for BackgroundGenerator2.js
if (!process.env.REPLICATE_API_TOKEN) {
  console.warn(
    "⚠️ REPLICATE_API_TOKEN is not set. Image generation via Flux/Replicate will be skipped or fail."
  );
}

// --- Client Initializations ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// --- HTML Generators Configuration ---
const htmlGenerators = [
  {
    name: "Approach-1",
    path: "C:\\Users\\rohit\\Niti projects local\\Niti ai projects\\Merged Approaches\\Different Approaches\\Approach-1\\html_generator.py",
    outputKey: "Approach-1_html",
  },
  {
    name: "Approach-2",
    path: "C:\\Users\\rohit\\Niti projects local\\Niti ai projects\\Merged Approaches\\Different Approaches\\Approach-2\\html_generator.py",
    outputKey: "Approach-2_html",
  },
  {
    name: "Approach-5",
    path: "C:\\Users\\rohit\\Niti projects local\\Niti ai projects\\Merged Approaches\\Different Approaches\\Approach-5\\html_generator.py", // This is your existing generator
    outputKey: "Approach-5_html",
  },
  // Add more approaches here as needed:
  // {
  //   name: "Approach-4 (New)",
  //   path: "C:\\Users\\rohit\\Niti projects local\\Niti ai projects\\Approach_2_v2\\poster_total\\backend\\creative_html_generator4.py",
  //   outputKey: "Approach-4_html",
  // },
];

// --- Helper Functions ---

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    console.error(
      "CosineSimilarity: Invalid inputs. Must be arrays of same length."
    );
    return 0;
  }
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return magA === 0 || magB === 0
    ? 0
    : Math.max(-1, Math.min(1, dot / (magA * magB)));
}

async function findSimilarCampaigns(description) {
  try {
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: description,
    });
    const inputEmbedding = embeddingResponse.data[0].embedding;

    const { data: campaigns, error: campaignError } = await supabase
      .from("campaigns_duplicate")
      .select("campaign_id, campaign_prompt, embedding");

    if (campaignError) {
      console.error(
        "Error fetching campaigns from Supabase:",
        campaignError.message
      );
      return [];
    }
    if (!campaigns || campaigns.length === 0) {
      console.warn("⚠️ No campaigns found in Supabase for similarity search.");
      return [];
    }

    const similarities = campaigns
      .map((c) => {
        // FIX: Correctly access c.embedding inside JSON.parse
        let emb =
          typeof c.embedding === "string"
            ? JSON.parse(c.embedding)
            : c.embedding;
        if (!Array.isArray(emb)) {
          console.warn(
            `Skipping campaign ${c.campaign_id} due to invalid embedding format.`
          );
          return null;
        }
        return { ...c, similarity: cosineSimilarity(inputEmbedding, emb) };
      })
      .filter(Boolean)
      .filter((c) => c.similarity > 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    if (!similarities.length) {
      console.log("📉 No similar campaigns found above threshold.");
      return [];
    }

    const campaignIds = similarities.map((c) => c.campaign_id);
    const { data: creatives, error: creativesError } = await supabase
      .from("creatives_duplicate")
      .select("*")
      .in("campaign_id", campaignIds);

    if (creativesError) {
      console.error(
        "⚠️ Error fetching creatives for similar campaigns:",
        creativesError.message
      );
      return [];
    }

    const combinedData = similarities
      .map((campaign) => {
        const creative = creatives?.find(
          (cr) => String(cr.campaign_id) === String(campaign.campaign_id)
        );
        return {
          ...campaign,
          creative: creative || null,
        };
      })
      .filter((item) => item.creative !== null);

    console.log(
      `✅ Found ${combinedData.length} similar creatives for inspiration.`
    );
    return combinedData;
  } catch (err) {
    console.error("❌ Error in findSimilarCampaigns:", err.message);
    return [];
  }
}

async function generateCreativeSpec(campaignPrompt, similarCreatives = []) {
  try {
    console.log(
      `🎯 Generating creative spec using ${similarCreatives.length} similar creatives as inspiration.`
    );

    const creativeExamples = similarCreatives
      .map((item, i) => {
        const creativeContent =
          item.creative?.creative_spec || item.creative?.ai_text;
        if (!creativeContent) return null;

        let parsedContent = creativeContent;
        if (typeof creativeContent === "string") {
          try {
            parsedContent = JSON.parse(creativeContent);
          } catch (e) {
            parsedContent = { description: creativeContent };
          }
        }

        return {
          example_id: item.campaign_id,
          prompt: item.campaign_prompt,
          spec: parsedContent,
        };
      })
      .filter(Boolean);

    const systemMessageContent = `You are a creative director for an ad design agency. Your task is to generate a detailed creative specification in JSON format based on a campaign prompt and optional examples.

        The JSON object you generate MUST include the following top-level keys: "placement", "dimensions", "format", and a nested "Canvas" object.
        All fields within this JSON structure are mandatory. Provide a value for every field. If a field is not directly applicable or inferable, provide a sensible default (e.g., empty string, empty array [], or an empty object {}).
        Specifically:
        - For arrays like "Text_Blocks" and "cta_buttons", always output an empty array "[]" if no elements are applicable. Do NOT use null.
        - For objects like "background", "brand_logo", "brand_colors", "Imagery", always output an empty object "{}" if no specific values are applicable, or if you suggest 'null' for their internal fields (like 'image' or 'url'). Do NOT use null for the object itself.

        The JSON schema should strictly follow this structure:

        {
          "placement": "string (e.g., 'social_media', 'homepage', 'email', 'app')",
          "dimensions": {
            "width": "number (e.g., 1200)",
            "height": "number (e.g., 800)"
          },
          "format": "string (e.g., 'static', 'gif', 'video', 'html5')",
          "Canvas": {
            "background": {
              "color": "string (hex code, e.g., '#ffffff')",
              "image": "string (null if no image, or a placeholder if AI wants to suggest one)",
              "description": "detailed visual description for image generation prompt (e.g., 'A snowy winter landscape featuring a cozy cabin surrounded by pine trees. Snowflakes gently fall from the sky, and a warm glow emanates from the cabin windows, creating a contrast with the cool, blue-tinted snow.')"
            },
            "layout_grid": "string (e.g., 'free', '2-col', '3-col', 'golden-ratio')",
            "bleed_safe_margins": "string (e.g., '10px')",
            "Imagery": {
              "background_image_url": "string (leave empty string, this will be filled by the image generation step)"
            },
            "Text_Blocks": [
              {
                "font": "string (e.g., 'sans-serif-bold', 'Montserrat')",
                "size": "string (e.g., 'large', 'x-large', 'xx-large', 'small', 'x-small')",
                "text": "string (e.g. 'GET 50% OFF')",
                "color": "string (hex code)",
                "position": "string (e.g., 'top-center', 'middle-left', 'bottom-right')"
              },
              {
                "font": "string (e.g., 'sans-serif-bold', 'Montserrat')",
                "size": "string (e.g., 'large', 'x-large', 'xx-large', 'small', 'x-small')",
                "text": "string (e.g. 'FOR ALL JEANS')",
                "color": "string (hex code)",
                "position": "string (e.g., 'top-center', 'middle-left', 'bottom-right')"
              },
              {
                "font": "string (e.g., 'sans-serif-bold', 'Montserrat')",
                "size": "string (e.g., 'large', 'x-large', 'xx-large', 'small', 'x-small')",
                "text": "string (e.g. 'Embrace the Style')",
                "color": "string (hex code)",
                "position": "string (e.g., 'top-center', 'middle-left', 'bottom-right')"
              }
            ],
            "cta_buttons": [
              {
                "text": "string (button text, e.g., 'Shop Now')",
                "color": "string (text color hex)",
                "position": "string (e.g., 'bottom-right')",
                "background": "string (button background hex)"
              }
            ],
            "brand_logo": {
              "url": "string (e.g., 'brand_logo.png', or 'null' if not applicable)",
              "size": "string (e.g., 'medium')",
              "position": "string (e.g., 'top-left')"
            },
            "brand_colors": {
              "accent": "string (hex code)",
              "primary": "string (hex code)",
              "secondary": "string (hex code)"
            },
            "slogan": "string (campaign slogan, or null)",
            "legal_disclaimer": "string (any legal fine print, or null)",
            "decorative_elements": "string (e.g., 'line', 'blob', 'sticker', or null)"
          }
        }

        For "Background Description", be very specific about visual elements (people, objects, setting, colors, style). Do not use mood words.
        If providing inspiration, extract the core visual and textual components from the 'spec' field of each example.
        `;

    let userMessageContent = `Campaign Prompt: "${campaignPrompt}"\n\n`;
    if (creativeExamples.length > 0) {
      userMessageContent += `Inspiration from similar campaigns:\n${JSON.stringify(
        creativeExamples,
        null,
        2
      )}\n\n`;
      userMessageContent += `Generate a new creative specification JSON object for this campaign, inspired by the examples, but unique. Strictly adhere to the JSON schema provided in the system message.`;
    } else {
      userMessageContent += `Generate a creative specification JSON object for this campaign. Strictly adhere to the JSON schema provided in the system message.`;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: systemMessageContent,
        },
        {
          role: "user",
          content: userMessageContent,
        },
      ],
    });

    const jsonString = completion.choices[0].message.content;
    console.log(
      "AI Raw JSON Output (first 500 chars):",
      jsonString.substring(0, 500) + (jsonString.length > 500 ? "..." : "")
    );

    try {
      const parsedSpec = JSON.parse(jsonString);
      console.log(
        "✅ Creative spec generated successfully by OpenAI and parsed."
      );
      return parsedSpec;
    } catch (parseError) {
      console.error("❌ Failed to parse AI generated JSON:", parseError);
      console.error("Raw AI response:", jsonString);
      throw new Error("Failed to parse AI generated JSON spec.");
    }
  } catch (error) {
    console.error("❌ Error generating creative spec with OpenAI:", error);
    throw new Error(`Failed to generate creative spec: ${error.message}`);
  }
}

async function saveCampaignAndCreativeSpec(prompt, aiGeneratedFullSpec) {
  try {
    const embeddingRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: prompt,
    });
    const embedding = embeddingRes.data[0].embedding;

    const { data: campaignInsert, error: campaignError } = await supabase
      .from("campaigns_duplicate")
      .insert([{ campaign_prompt: prompt, embedding: embedding }])
      .select();

    if (campaignError) {
      console.error("❌ Campaign insert error:", campaignError);
      throw campaignError;
    }

    const campaign_id = campaignInsert[0].campaign_id;
    console.log("✅ Campaign saved with ID:", campaign_id);

    // --- Post-processing and Normalization of aiGeneratedFullSpec ---
    // Ensure Canvas and its sub-objects/arrays exist and are of the correct type
    aiGeneratedFullSpec.Canvas = aiGeneratedFullSpec.Canvas || {};
    // Ensure nested objects/arrays are always initialized to their expected type
    aiGeneratedFullSpec.Canvas.background = aiGeneratedFullSpec.Canvas
      .background || { color: "#ffffff", image: null, description: "" };
    aiGeneratedFullSpec.Canvas.Imagery = aiGeneratedFullSpec.Canvas.Imagery || {
      background_image_url: null,
    };
    aiGeneratedFullSpec.Canvas.Text_Blocks = Array.isArray(
      aiGeneratedFullSpec.Canvas.Text_Blocks
    )
      ? aiGeneratedFullSpec.Canvas.Text_Blocks
      : [];
    aiGeneratedFullSpec.Canvas.cta_buttons = Array.isArray(
      aiGeneratedFullSpec.Canvas.cta_buttons
    )
      ? aiGeneratedFullSpec.Canvas.cta_buttons
      : [];
    aiGeneratedFullSpec.Canvas.brand_logo = aiGeneratedFullSpec.Canvas
      .brand_logo || { url: null, size: null, position: null };

    // More robust brand_colors handling: ensure it's an object or null for DB
    let brandColorsForDb = aiGeneratedFullSpec.Canvas.brand_colors;
    if (typeof brandColorsForDb !== "object" || brandColorsForDb === null) {
      brandColorsForDb = { accent: null, primary: null, secondary: null };
    }

    aiGeneratedFullSpec.Canvas.layout_grid =
      aiGeneratedFullSpec.Canvas.layout_grid || "free";
    aiGeneratedFullSpec.Canvas.bleed_safe_margins =
      aiGeneratedFullSpec.Canvas.bleed_safe_margins || "";
    aiGeneratedFullSpec.Canvas.slogans =
      aiGeneratedFullSpec.Canvas.slogans || null;
    aiGeneratedFullSpec.Canvas.legal_disclaimer =
      aiGeneratedFullSpec.Canvas.legal_disclaimer || null;

    // Ensure decorative_elements is an array or null
    let decorativeElementsForDb =
      aiGeneratedFullSpec.Canvas.decorative_elements;
    if (
      typeof decorativeElementsForDb !== "object" ||
      decorativeElementsForDb === null
    ) {
      decorativeElementsForDb = null; // Or [], depending on your schema. If JSONB allows [], prefer that.
    } else if (!Array.isArray(decorativeElementsForDb)) {
      // If it's an object but not an array, make it an empty array for consistency
      decorativeElementsForDb = [];
    }
    // Note: If decorative_elements is an array of objects, this should ensure it's an array.

    // Prepare the creative object for insertion, ensuring JSONB fields are proper objects/arrays or null
    const creativeInsertPayload = {
      campaign_id: campaign_id,
      placement: aiGeneratedFullSpec.placement || "social_media",
      dimensions: aiGeneratedFullSpec.dimensions || {
        width: 720,
        height: 720,
      },
      format: aiGeneratedFullSpec.format || "static",
      background: aiGeneratedFullSpec.Canvas.background,
      text_blocks: aiGeneratedFullSpec.Canvas.Text_Blocks,
      cta_buttons: aiGeneratedFullSpec.Canvas.cta_buttons,
      brand_logo: aiGeneratedFullSpec.Canvas.brand_logo,
      brand_colors: brandColorsForDb, // Use the normalized value
      // --- IMPORTANT: Ensure Imagery is an object, even if empty ---
      imagery: aiGeneratedFullSpec.Canvas.Imagery || {
        background_image_url: null,
      }, // Ensure this is always an object
      // ------------------------------------------------------------
      slogan: aiGeneratedFullSpec.Canvas.slogans, // Corrected from aiGeneratedFullSpec.Canvas.slogan
      legal_disclaimer: aiGeneratedFullSpec.Canvas.legal_disclaimer,
      decorative_elements: decorativeElementsForDb, // Use the normalized value
      creative_spec: aiGeneratedFullSpec, // Save the ENTIRE full spec
      status: "generated",
    };

    const { data: creativeData, error: creativeError } = await supabase
      .from("creatives_duplicate")
      .insert([creativeInsertPayload])
      .select();

    if (creativeError) {
      console.error(`❌ Creative spec insert error:`, creativeError);
      // Log the payload that caused the error for debugging
      console.error(
        "❌ Payload that caused error:",
        JSON.stringify(creativeInsertPayload, null, 2)
      );
      console.error(
        "❌ Error details:",
        JSON.stringify(creativeError, null, 2)
      );
      throw creativeError;
    } else {
      console.log(
        `✅ Creative spec saved successfully with ID: ${creativeData[0].creative_id}.`
      );
      return {
        campaign_id,
        creative: creativeData[0],
      };
    }
  } catch (err) {
    console.error("❌ Failed to save campaign and creative spec:", err);
    throw err;
  }
}

async function transformCreativeToRequiredElementsSchema(
  creativeObjectFromDb,
  campaignPrompt
) {
  // Ensure we are working with the latest creative_spec structure from the DB
  const fullCreativeSpec = creativeObjectFromDb.creative_spec || {};
  const creativeSpecCanvas = fullCreativeSpec.Canvas || {};
  const dimensions = fullCreativeSpec.dimensions || { width: 720, height: 720 };
  const placement = fullCreativeSpec.placement || "social_media";
  const format = fullCreativeSpec.format || "static";

  return {
    campaign_id: creativeObjectFromDb.campaign_id,
    campaign_prompt: campaignPrompt,
    placement: placement,
    dimensions: {
      width: dimensions.width,
      height: dimensions.height,
    },
    format: format,
    Canvas: {
      background: creativeSpecCanvas.background || {
        color: "#ffffff",
        image: "",
        description: "",
      },
      layout_grid: creativeSpecCanvas.layout_grid || "free",
      bleed_safe_margins: creativeSpecCanvas.bleed_safe_margins || "",
      Imagery: {
        // This should now be populated by BackgroundGenerator.js via creative_spec.Canvas.Imagery
        background_image_url:
          creativeSpecCanvas.Imagery?.background_image_url || null,
      },
      Text_Blocks: creativeSpecCanvas.Text_Blocks || [],
      cta_buttons: creativeSpecCanvas.cta_buttons || [],
      brand_logo: creativeSpecCanvas.brand_logo || {
        url: null,
        size: null,
        position: null,
      },
      brand_colors: creativeSpecCanvas.brand_colors || {
        accent: null,
        primary: null,
        secondary: null,
      },
      slogans: creativeSpecCanvas.slogans || null,
      legal_disclaimer: creativeSpecCanvas.legal_disclaimer || null,
      decorative_elements: creativeSpecCanvas.decorative_elements || null,
    },
  };
}

async function generateHtmlFromPython(scriptPath, creativeId, campaignPrompt) {
  // <--- Added scriptPath here
  return new Promise((resolve, reject) => {
    // const pythonScriptPath = "C:\\Users\\rohit\\Niti projects local\\Niti ai projects\\Approach_2_v2\\poster_total\\backend\\creative_html_generator3.py"; // REMOVE THIS LINE, now passed as argument

    const pythonExecutable = "python";

    console.log(
      `Executing Python script: ${scriptPath} with creativeId: ${creativeId} and campaignPrompt: "${campaignPrompt}"` // <--- Use scriptPath
    );

    const pythonProcess = spawn(pythonExecutable, [
      scriptPath, // <--- Use scriptPath here
      creativeId,
      campaignPrompt,
    ]);

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code === 0) {
        console.log(`Python script (${scriptPath}) exited successfully.`); // <--- Added scriptPath to log
        resolve(stdout.trim());
      } else {
        console.error(`Python script (${scriptPath}) exited with code ${code}`); // <--- Added scriptPath to log
        console.error("Full Python stderr:", stderr);
        reject(
          new Error(
            `Python script (${scriptPath}) failed with code ${code}. Error: ${
              // <--- Added scriptPath to error
              stderr || "Unknown error"
            }`
          )
        );
      }
    });

    pythonProcess.on("error", (err) => {
      console.error(
        "Failed to start Python process (check pythonExecutable path or permissions):",
        err
      );
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });
  });
}

// --- CONSOLIDATED API ENDPOINT ---
app.post("/api/generate-full-creative", async (req, res) => {
  const { campaignPrompt } = req.body;

  if (!campaignPrompt) {
    return res.status(400).json({ error: "campaignPrompt is required" });
  }

  try {
    console.log(
      "🌟 Starting full creative generation process for prompt:",
      campaignPrompt
    );

    // Step 1: Find similar campaigns for inspiration
    const similarCreativesData = await findSimilarCampaigns(campaignPrompt);
    const similarCreativeSpecs = similarCreativesData
      .map((item) => ({
        id: item.campaign_id,
        prompt: item.campaign_prompt,
        spec: item.creative?.creative_spec, // Use creative_spec directly
      }))
      .filter((item) => item.spec !== null);

    // Step 2: Generate creative spec (JSON) directly from OpenAI
    const aiGeneratedFullSpec = await generateCreativeSpec(
      campaignPrompt,
      similarCreativeSpecs
    );
    if (!aiGeneratedFullSpec) {
      throw new Error("Failed to generate creative spec from AI.");
    }
    console.log("✅ Generated AI creative spec (JSON) successfully.");

    // Step 3: Save campaign and structured creative spec to Supabase
    const saveResult = await saveCampaignAndCreativeSpec(
      campaignPrompt,
      aiGeneratedFullSpec
    );
    if (
      !saveResult ||
      !saveResult.creative ||
      !saveResult.creative.creative_id
    ) {
      throw new Error("Failed to save creative or retrieve creative_id.");
    }
    const creativeId = saveResult.creative.creative_id;
    let creativeObjectFromDb = saveResult.creative; // Initial creative object from DB
    console.log(`✅ Creative spec saved with ID: ${creativeId}.`);

    // Step 4: Generate images using the BackgroundGenerator.js module
    let imageResults = [];
    console.log("🎨 Starting image generation via BackgroundGenerator.js...");
    try {
      // Pass the creative object in an array as expected by BackgroundGenerator.js
      // BackgroundGenerator.js will update creative_spec.Canvas.Imagery.background_image_url
      // The prompt for image generation comes from creativeObjectFromDb.background.description
      imageResults = await generateImagesForCreatives(
        [creativeObjectFromDb],
        "flux"
      );

      // IMPORTANT: Re-fetch the creative object after image generation to get the updated creative_spec
      const { data: updatedCreative, error: fetchError } = await supabase
        .from("creatives_duplicate")
        .select("*")
        .eq("creative_id", creativeId)
        .single();

      if (fetchError) {
        console.error(
          `Error fetching updated creative ${creativeId} after image gen:`,
          fetchError.message
        );
        // Optionally, handle this error more gracefully, but proceed with potentially outdated data
      } else {
        creativeObjectFromDb = updatedCreative; // Update the creative object with the latest data
      }

      const successfulImageGens = imageResults.filter((r) => r.success).length;
      console.log(
        `✅ Image generation process completed. Generated ${successfulImageGens} images.`
      );
    } catch (imageError) {
      console.error(
        "❌ Image generation failed in main API endpoint (outer catch):",
        imageError.message
      );
      imageResults.push({
        creative_id: creativeId,
        success: false,
        message: `Overall image generation failed: ${imageError.message}`,
      });
    }

    // Step 5: Transform the latest creative object into the required_elements schema for response
    // Use the re-fetched creativeObjectFromDb here
    const campaignPromptFromDb = await getCampaignPromptFromDb(
      saveResult.campaign_id
    );
    const requiredElementsOutput =
      await transformCreativeToRequiredElementsSchema(
        creativeObjectFromDb,
        campaignPromptFromDb || campaignPrompt
      );
    console.log(
      "✅ Transformed creative data to required_elements schema for response."
    );

    // --- Step 6: Generate HTML using MULTIPLE Python scripts ---
    const htmlOutputs = {}; // Object to store all HTML results

    // Create an array of promises for each HTML generation task
    const htmlGenerationTasks = htmlGenerators.map(async (generator) => {
      let generatedHtml = "";
      try {
        console.log(
          `🚀 Attempting to generate HTML for ${generator.name} (ID: ${creativeId}, Prompt: "${campaignPrompt}").`
        );
        generatedHtml = await generateHtmlFromPython(
          generator.path, // Pass the specific script path
          creativeId,
          campaignPrompt
        );
        console.log(
          `✅ HTML generation for ${generator.name} completed successfully.`
        );
      } catch (htmlError) {
        console.error(
          `❌ HTML generation for ${generator.name} failed:`,
          htmlError.message
        );
        generatedHtml = ""; // Return empty string or an error message if a script fails
      }
      return { key: generator.outputKey, html: generatedHtml };
    });

    // Run all HTML generation tasks in parallel
    const results = await Promise.all(htmlGenerationTasks);

    // Populate the htmlOutputs object with the results
    results.forEach((result) => {
      htmlOutputs[result.key] = result.html;
    });

    // --- End of Step 6 ---

    // Final Response
    res.json({
      // Provide all generated HTMLs
      ...htmlOutputs, // <--- Spread the collected HTML outputs here
    });
  } catch (err) {
    console.error("❌ Error in /api/generate-full-creative:", err);
    res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
      step_failed: err.step || "unknown",
    });
  }
});

async function getCampaignPromptFromDb(campaignId) {
  try {
    const { data, error } = await supabase
      .from("campaigns_duplicate")
      .select("campaign_prompt")
      .eq("campaign_id", campaignId)
      .single();
    if (error) {
      console.error(`Error fetching campaign prompt for ${campaignId}:`, error);
      return null;
    }
    return data ? data.campaign_prompt : null;
  } catch (e) {
    console.error(`Exception fetching campaign prompt for ${campaignId}:`, e);
    return null;
  }
}

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(
    `Access the single creative generation endpoint at: http://localhost:${port}/api/generate-full-creative`
  );
});
