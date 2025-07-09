import json
import os
import sys
import requests
from dotenv import load_dotenv
from openai import OpenAI
from supabase import create_client, Client
import argparse

# Assuming run_layoutgpt_2d is a local module you have
from functions import gpt_generation, llm_name2id

# Load environment variables from .env file
load_dotenv()

# --- Supabase Configuration ---
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") # Ensure this is your service_role key

if not SUPABASE_URL or not SUPABASE_KEY:
    # Changed to stderr
    print("Error: SUPABASE_URL or SUPABASE_KEY environment variables are not set for Supabase client.", file=sys.stderr)
    sys.exit(1)

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    # Changed to stderr
    print("Supabase client initialized.", file=sys.stderr)
except Exception as e:
    # Changed to stderr
    print(f"Error initializing Supabase client: {e}", file=sys.stderr)
    sys.exit(1)

# --- Configuration for file paths ---
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'output_html_approach1')
FINAL_HTML_NAME = "final_creative_approach1.html"
FINAL_HTML_PATH = os.path.join(OUTPUT_DIR, FINAL_HTML_NAME)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# -------- Helper Functions (Integrated from your previous code) --------

def download_image(image_url, save_path):
    """Downloads an image from a URL and saves it locally.
    Note: This specific function is not directly called in this HTML generation
    logic but is included as it was part of your provided helpers.
    """
    # Changed to stderr
    print(f"Downloading image from {image_url} to {save_path}...", file=sys.stderr)
    try:
        response = requests.get(image_url)
        response.raise_for_status()
        with open(save_path, 'wb') as f:
            f.write(response.content)
        # Changed to stderr
        print(f"Image saved to {save_path}", file=sys.stderr)
        return True
    except requests.exceptions.RequestException as e:
        # Already stderr, keeping for consistency
        print(f"Failed to download image from {image_url}: {e}", file=sys.stderr)
        return False

def get_font_size_px(size_str):
    """Converts a descriptive font size string to an approximate pixel value.
    Note: This specific function is not directly called in this HTML generation
    logic but is included as it was part of your provided helpers.
    """
    size_map = {
        "small": 20, "medium": 30, "large": 45,
        "x-large": 60, "xx-large": 80, "xxx-large": 100
    }
    return size_map.get(size_str.lower(), 30)

def fetch_creative_data_from_supabase(creative_id: str):
    # Changed to stderr
    print(f"\n--- Fetching creative data for ID: {creative_id} from Supabase ---", file=sys.stderr)
    try:
        # We are selecting all columns to get the top-level keys
        response = supabase.table('creatives_duplicate').select('*').eq('creative_id', creative_id).single().execute()
        data = response.data

        if not data:
            # Already stderr, keeping for consistency
            print(f"No creative found with ID: {creative_id}", file=sys.stderr)
            raise ValueError(f"Creative ID {creative_id} not found.")

        # Changed to stderr
        print(f"Creative data fetched successfully for ID: {creative_id}", file=sys.stderr)
        print(f"Raw Supabase creative data: {json.dumps(data, indent=2)}", file=sys.stderr) # Added for debugging
        return data
    except Exception as e:
        # Already stderr, keeping for consistency
        print(f"Error in fetching creative data: {e}", file=sys.stderr)
        raise

def fetch_campaign_prompt_from_supabase(campaign_id: str):
    """
    Fetches the campaign_prompt from the 'campaigns_duplicate' table in Supabase.
    """
    # Changed to stderr
    print(f"\n--- Fetching campaign prompt for ID: {campaign_id} from Supabase ---", file=sys.stderr)
    try:
        response = supabase.table('campaigns_duplicate') \
                           .select('campaign_prompt') \
                           .eq('campaign_id', campaign_id) \
                           .single() \
                           .execute()

        data = response.data

        if not data:
            # Already stderr, keeping for consistency
            print(f"No campaign found with ID: {campaign_id}", file=sys.stderr)
            raise ValueError(f"Campaign ID {campaign_id} not found.")

        # Changed to stderr
        print(f"Campaign prompt fetched successfully for ID: {campaign_id}", file=sys.stderr)
        return data.get('campaign_prompt', "")
    except Exception as e:
        # Already stderr, keeping for consistency
        print(f"Error fetching campaign prompt: {e}", file=sys.stderr)
        raise

def map_supabase_to_required_elements_schema(supabase_creative_data: dict, campaign_prompt: str) -> dict:
    # Changed to stderr
    print("\n--- Mapping Supabase data to required_elements schema (Python) ---", file=sys.stderr)
    print(f"Mapping input - supabase_creative_data type: {type(supabase_creative_data)}, value: {json.dumps(supabase_creative_data, indent=2)}", file=sys.stderr)
    print(f"Mapping input - campaign_prompt: {campaign_prompt}", file=sys.stderr)

    # Safely get the 'creative_spec' column, which should contain the entire JSON structure
    # The server.js code does JSON.parse(JSON.stringify(creative_data))
    # so Supabase should store it as a proper JSONB object.
    creative_spec = supabase_creative_data.get("creative_spec")

    if not isinstance(creative_spec, dict):
        # If 'creative_spec' is not a dictionary, it means it's missing or malformed.
        # This is a critical error as the rest of the logic expects it.
        print(f"Error: 'creative_spec' column is missing or not a valid JSON object. Value: {creative_spec}", file=sys.stderr)
        raise ValueError("Invalid or missing 'creative_spec' in Supabase data.")

    # Now, extract data from within the 'creative_spec' dictionary
    canvas_data = creative_spec.get("Canvas", {})
    dimensions = creative_spec.get("dimensions", {"width": 1080, "height": 1920}) # Default to 1080x1920 as per Replicate
    placement = creative_spec.get("placement", "social_media")
    format_val = creative_spec.get("format", "static")

    # Helper to safely get nested values with defaults
    def safe_get_nested(data_dict, keys, default_value):
        temp = data_dict
        for key in keys:
            if isinstance(temp, dict):
                temp = temp.get(key)
            else:
                return default_value
        return temp if temp is not None else default_value

    mapped_data = {
        "campaign_id": supabase_creative_data.get("campaign_id"), # This is a top-level column
        "campaign_prompt": campaign_prompt, # This comes from the function argument
        "placement": placement,
        "dimensions": dimensions,
        "format": format_val,
        "Canvas": {
            "background": safe_get_nested(canvas_data, ["background"], {"color": "#ffffff", "image": None, "description": ""}),
            "layout_grid": safe_get_nested(canvas_data, ["layout_grid"], "free"),
            "bleed_safe_margins": safe_get_nested(canvas_data, ["bleed_safe_margins"], ""),
            "Imagery": {
                "background_image_url": safe_get_nested(canvas_data, ["Imagery", "background_image_url"], None)
            },
            "Text_Blocks": safe_get_nested(canvas_data, ["Text_Blocks"], []),
            "cta_buttons": safe_get_nested(canvas_data, ["cta_buttons"], []),
            "brand_logo": safe_get_nested(canvas_data, ["brand_logo"], {
                "url": None, # Assuming server.js doesn't populate this directly yet
                "text_alt": "Brand Logo",
                "size": "medium",
                "position": "top-left"
            }),
            "brand_colors": safe_get_nested(canvas_data, ["brand_colors"], []),
            "slogans": safe_get_nested(canvas_data, ["slogans"], None),
            "legal_disclaimer": safe_get_nested(canvas_data, ["legal_disclaimer"], None),
            "decorative_elements": safe_get_nested(canvas_data, ["decorative_elements"], [])
        }
    }

    # Ensure lists are actually lists, handling potential empty string or non-list values from DB
    if not isinstance(mapped_data["Canvas"]["brand_colors"], list):
        print(f"Warning: 'brand_colors' was not a list, converting to empty list. Value: {mapped_data['Canvas']['brand_colors']}", file=sys.stderr)
        mapped_data["Canvas"]["brand_colors"] = []

    if not isinstance(mapped_data["Canvas"]["decorative_elements"], list):
        print(f"Warning: 'decorative_elements' was not a list, converting to empty list. Value: {mapped_data['Canvas']['decorative_elements']}", file=sys.stderr)
        mapped_data["Canvas"]["decorative_elements"] = []
    # This check is less critical now if safe_get_nested correctly defaults to [], but good for robustness
    if mapped_data["Canvas"]["decorative_elements"] == "" or mapped_data["Canvas"]["decorative_elements"] is None:
        mapped_data["Canvas"]["decorative_elements"] = []

    # Changed to stderr
    print("Mapped schema (Python):", json.dumps(mapped_data, indent=2), file=sys.stderr)
    return {"required_elements": mapped_data}

# -------- Main Function for Approach-1 HTML Generation --------
def main():
    # -------- Parse CLI args --------
    parser = argparse.ArgumentParser(description="Generate a marketing HTML creative directly from Supabase data using an LLM.")
    parser.add_argument("creative_id", type=str, help="ID of the creative to fetch from Supabase.")
    parser.add_argument("campaign_prompt_cli", type=str, help="Campaign prompt (initial or fallback from CLI).")
    parser.add_argument("--llm_type", type=str, default="gpt4o", choices=["gpt4o", "gpt4", "gpt3.5"], help="LLM type to use (default: gpt4o)")
    args = parser.parse_args()

    # -------- Setup OpenAI Client --------
    client = OpenAI()
    llm_id = llm_name2id[args.llm_type]

    try:
        # Phase 0: Fetch creative data from Supabase
        supabase_creative_data = fetch_creative_data_from_supabase(args.creative_id)

        # Determine the campaign_id from the fetched creative data
        campaign_id_from_creative = supabase_creative_data.get("campaign_id")

        campaign_prompt_final = args.campaign_prompt_cli # Initialize with CLI prompt as fallback
        if campaign_id_from_creative:
            try:
                # Fetch the *actual* campaign_prompt from the campaigns_duplicate table
                campaign_prompt_from_db = fetch_campaign_prompt_from_supabase(campaign_id_from_creative)
                # Changed to stderr
                print(f"Fetched campaign_prompt from DB: '{campaign_prompt_from_db}'", file=sys.stderr)
                campaign_prompt_final = campaign_prompt_from_db
            except Exception as e:
                # Already stderr, keeping for consistency
                print(f"Warning: Could not fetch campaign prompt from DB for campaign_id {campaign_id_from_creative}: {e}. Using CLI prompt.", file=sys.stderr)
                # campaign_prompt_final remains args.campaign_prompt_cli

        # Phase 0.1: Map Supabase data to the expected 'required_elements' schema
        # Use the prompt fetched from DB (or CLI fallback) for the mapped data
        creative_data_for_processing = map_supabase_to_required_elements_schema(supabase_creative_data, campaign_prompt_final)

        # This is the actual data payload that will be passed to the LLM prompt
        creative_data = creative_data_for_processing["required_elements"]

        # -------- Build refined prompt for GPT --------
        system_prompt = (
            "You are an expert HTML & CSS ad designer. "
            "Given a JSON object that describes a marketing creative — like background, imagery, text blocks, and CTA buttons — "
            "generate a COMPLETE HTML document. "
            "Use absolute positioning based on the estimated-coords provided. "
            "Ensure fonts, colors, and styles match the JSON data. "
            "Use background images where applicable. "
            "Make sure the HTML is visually balanced, looks professional, and resembles a typical marketing creative. "
            "Center the entire creative container in the middle of the browser both vertically and horizontally. "
            "Use reasonable default styling for any unspecified properties. "
            "Output ONLY valid HTML code — no explanations."
        )

        user_prompt = f"""
Here is the JSON describing the marketing creative layout:
{json.dumps(creative_data, indent=2)}

Please produce a complete HTML document implementing this exactly,
using absolute positioning and applying the specified fonts, colors, background textures,
and texts. Ensure it looks like a polished marketing ad.

**CRITICAL LAYOUT INSTRUCTIONS FOR OPTIMAL VISUAL BALANCE AND READABILITY:**

1.  **Strict No-Overlap Rule:** ABSOLUTELY ENSURE that no text block, CTA button, or the brand logo overlaps with any primary subjects in the background image (e.g., people, faces, products, animals, or other prominent visual elements). Identify and utilize clear, empty background space.

2. Follow placement of text using the 'relative_position' of the text with one another.'top' for text does not necessarily mean top of the marketing creative, it means top modt text box.

3.  **Guaranteed Readability:**
    * For ALL text, ensure maximum contrast against the background. If the background image is busy or has varying colors, *add a subtle, semi-transparent background color (e.g., a slightly opaque black or white box) or a strong text-shadow behind the text* to ensure it pops and is easily readable.
    * The text must be legible at a glance.

4. **Maintain a visual heirarcy where the background image especially the part of the image which contains people/products/animals/anything with a lot of visual features is the most important should not be masked by any other element.**"

5.  **Professional Aesthetic:** The final HTML must render as a professional, clean, and visually appealing marketing advertisement. Elements should be neatly aligned and spaced, avoiding any cluttered or amateurish appearance.

6.  **Absolute Positioning Refinement:** Use the provided dimensions and positions as a guide, but adjust absolute `top`, `left`, `right`, `bottom` values as necessary to strictly adhere to the no-overlap and readability rules.
"""

        # -------- Call GPT --------
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]

        response_text, _ = gpt_generation(
            messages,
            client.chat.completions.create,
            llm_id=llm_id
        )

        final_html = response_text[0]

        # -------- Save output and Print to stdout --------
        # Still saving to file for local access/debugging
        with open(FINAL_HTML_PATH, "w", encoding="utf-8") as f:
            f.write(final_html)

        # Changed to stderr
        print(f"\n Final HTML ad saved to {FINAL_HTML_PATH}", file=sys.stderr)
        # Changed to stderr
        print(f"You can open it in your browser: file://{os.path.abspath(FINAL_HTML_PATH)}", file=sys.stderr)

        # IMPORTANT: Output the HTML content to stdout so Node.js can capture it
        # Removed the header, only print the HTML
        print(final_html)

    except FileNotFoundError as e:
        # Already stderr, keeping for consistency
        print(f"Error: {e}. Please ensure all required files and directories exist.", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        # Already stderr, keeping for consistency
        print(f"Data Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        # Already stderr, keeping for consistency
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        # Added traceback for better debugging
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()