// main.js

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { spawn } = require("child_process");
const path = require("path");
const fetch = require("node-fetch"); // Ensure node-fetch is imported if not using Node 18+ native fetch

// Load environment variables
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3001;

// --- Environment Variable Checks ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error(
    "❌ Missing essential environment variables (SUPABASE_URL, SUPABASE_KEY)."
  );
  process.exit(1);
}

// --- Client Initializations ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());

// --- HTML Generators Configuration ---
const htmlGenerators = [
  {
    name: "Approach-1",
    path: path.join(
      __dirname,
      "..",
      "Different Approaches",
      "Approach-1",
      "html_generator.py"
    ),
    outputKey: "Approach-1_html", // This will be the column name
  },
  {
    name: "Approach-2",
    path: path.join(
      __dirname,
      "..",
      "Different Approaches",
      "Approach-2",
      "html_generator.py"
    ),
    outputKey: "Approach-2_html", // This will be the column name
  },
  // {
  //   name: "Approach-5",
  //   path: path.join(
  //     __dirname,
  //     "..",
  //     "Different Approaches",
  //     "Approach-5",
  //     "html_generator.py"
  //   ),
  //   outputKey: "Approach-5_html", // This will be the column name
  // },
];

// --- Helper Functions ---

async function generateHtmlFromPython(scriptPath, creativeId, campaignPrompt) {
  return new Promise((resolve, reject) => {
    const pythonExecutable = "python"; // Or provide full path like '/usr/bin/python3'

    console.log(
      `Executing Python script: ${scriptPath} with creativeId: ${creativeId} and campaignPrompt: "${campaignPrompt}"`
    );

    const pythonProcess = spawn(pythonExecutable, [
      scriptPath,
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
        console.log(`Python script (${scriptPath}) exited successfully.`);
        resolve(stdout.trim());
      } else {
        console.error(`Python script (${scriptPath}) exited with code ${code}`);
        console.error("Full Python stderr:", stderr);
        reject(
          new Error(
            `Python script (${scriptPath}) failed with code ${code}. Error: ${
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

// Helper function to get campaign prompt
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

// --- CONSOLIDATED API ENDPOINT ---
app.post("/api/generate-full-creative", async (req, res) => {
  const { creative_id } = req.body;

  if (!creative_id) {
    return res
      .status(400)
      .json({ error: "creative_id is required in the request body." });
  }

  try {
    // 1. Fetch creative details to get the campaign_id first
    const { data: creativeData, error: creativeError } = await supabase
      .from("creatives_duplicate")
      .select("campaign_id")
      .eq("creative_id", creative_id)
      .single();

    if (creativeError || !creativeData) {
      console.error(
        `❌ Error fetching creative with ID ${creative_id}:`,
        creativeError?.message || "Not found"
      );
      return res
        .status(404)
        .json({ error: `Creative with ID ${creative_id} not found.` });
    }

    const campaign_id = creativeData.campaign_id; // Retrieve campaign_id

    // 2. Fetch the campaign_prompt using the retrieved campaign_id
    const campaignPrompt = await getCampaignPromptFromDb(campaign_id);

    if (!campaignPrompt) {
      console.error(
        `❌ Campaign prompt not found for campaign ID ${campaign_id}`
      );
      return res.status(404).json({
        error: `Campaign prompt not found for campaign ID ${campaign_id}.`,
      });
    }

    console.log(
      `✅ Retrieved creative_id: ${creative_id}, campaign_id: ${campaign_id}, campaign_prompt: "${campaignPrompt}"`
    );

    // --- Step: Generate HTML using MULTIPLE Python scripts ---
    const htmlOutputs = {}; // Object to store all HTML results

    // Create an array of promises for each HTML generation task
    const htmlGenerationTasks = htmlGenerators.map(async (generator) => {
      let generatedHtml = "";
      try {
        console.log(
          `🚀 Attempting to generate HTML for ${generator.name} (Creative ID: ${creative_id}, Campaign Prompt: "${campaignPrompt}").`
        );
        generatedHtml = await generateHtmlFromPython(
          generator.path,
          creative_id,
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
        generatedHtml = ""; // Ensure it's an empty string on failure
      }
      return { key: generator.outputKey, html: generatedHtml };
    });

    // Run all HTML generation tasks in parallel
    const results = await Promise.all(htmlGenerationTasks);

    // Populate the htmlOutputs object with the results
    results.forEach((result) => {
      htmlOutputs[result.key] = result.html;
    });

    // --- NEW: Step to save generated HTMLs to Supabase ---
    console.log(
      `Attempting to save generated HTMLs for creative_id: ${creative_id} to Supabase.`
    );
    console.log("HTML Outputs to save:", Object.keys(htmlOutputs)); // Log keys being saved

    const { data: updateData, error: updateError } = await supabase
      .from("creatives_duplicate")
      .update(htmlOutputs) // htmlOutputs object directly maps to column_name: value
      .eq("creative_id", creative_id);

    if (updateError) {
      console.error(
        `❌ Error saving HTML outputs to Supabase for creative_id ${creative_id}:`,
        updateError.message
      );
      // You might choose to still send the HTML outputs even if saving to DB fails,
      // or to return an error depending on your application's requirements.
    } else {
      console.log(
        `✅ Successfully saved HTML outputs to Supabase for creative_id ${creative_id}.`
      );
    }

    // Final Response
    res.json({
      ...htmlOutputs,
      message: updateError
        ? "HTMLs generated, but failed to save to database."
        : "HTMLs generated and saved successfully.",
      dbSaveError: updateError ? updateError.message : null,
    });
  } catch (error) {
    console.error("❌ Error in /api/generate-full-creative endpoint:", error);
    res
      .status(500)
      .json({ error: "Internal server error during creative generation." });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(
    `Access the single creative generation endpoint at: http://localhost:${port}/api/generate-full-creative`
  );
});
