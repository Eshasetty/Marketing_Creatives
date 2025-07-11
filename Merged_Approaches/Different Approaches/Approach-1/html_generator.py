import json
import os
import sys
import requests
import re # Import the re module for regular expressions
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
    print("Error: SUPABASE_URL or SUPABASE_KEY environment variables are not set for Supabase client.", file=sys.stderr)
    sys.exit(1)

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("Supabase client initialized.", file=sys.stderr)
except Exception as e:
    print(f"Error initializing Supabase client: {e}", file=sys.stderr)
    sys.exit(1)

# -------- Helper Functions --------

def download_image(image_url, save_path):
    """Downloads an image from a URL and saves it locally.
    Note: This specific function is not directly called in this HTML generation
    logic and its use case might change if HTML generation no longer relies on
    local image paths. It is kept for completeness as it was part of your provided helpers.
    """
    print(f"Downloading image from {image_url} to {save_path}...", file=sys.stderr)
    try:
        response = requests.get(image_url)
        response.raise_for_status()
        with open(save_path, 'wb') as f:
            f.write(response.content)
        print(f"Image saved to {save_path}", file=sys.stderr)
        return True
    except requests.exceptions.RequestException as e:
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
    print(f"\n--- Fetching creative data for ID: {creative_id} from Supabase ---", file=sys.stderr)
    try:
        response = supabase.table('creatives_duplicate').select('*').eq('creative_id', creative_id).single().execute()
        data = response.data

        if not data:
            print(f"No creative found with ID: {creative_id}", file=sys.stderr)
            raise ValueError(f"Creative ID {creative_id} not found.")

        print(f"Creative data fetched successfully for ID: {creative_id}", file=sys.stderr)
        # print(f"Raw Supabase creative data: {json.dumps(data, indent=2)}", file=sys.stderr) # Keep commented for production verbosity
        return data
    except Exception as e:
        print(f"Error in fetching creative data: {e}", file=sys.stderr)
        raise

def fetch_campaign_prompt_from_supabase(campaign_id: str):
    """
    Fetches the campaign_prompt from the 'campaigns_duplicate' table in Supabase.
    """
    print(f"\n--- Fetching campaign prompt for ID: {campaign_id} from Supabase ---", file=sys.stderr)
    try:
        response = supabase.table('campaigns_duplicate') \
                            .select('campaign_prompt') \
                            .eq('campaign_id', campaign_id) \
                            .single() \
                            .execute()

        data = response.data

        if not data:
            print(f"No campaign found with ID: {campaign_id}", file=sys.stderr)
            raise ValueError(f"Campaign ID {campaign_id} not found.")

        print(f"Campaign prompt fetched successfully for ID: {campaign_id}", file=sys.stderr)
        return data.get('campaign_prompt', "")
    except Exception as e:
        print(f"Error fetching campaign prompt: {e}", file=sys.stderr)
        raise

def map_supabase_to_required_elements_schema(supabase_creative_data: dict, campaign_prompt: str) -> dict:
    """
    Maps the data fetched from Supabase (where fields are top-level columns)
    into the 'required_elements' schema that the rest of the Python script understands.
    This version aligns with Approach-2's mapping logic.
    """
    print("\n--- Mapping Supabase data to required_elements schema (Approach-1) ---", file=sys.stderr)
    # print(f"Mapping input - supabase_creative_data type: {type(supabase_creative_data)}, value: {json.dumps(supabase_creative_data, indent=2)}", file=sys.stderr)
    print(f"Mapping input - campaign_prompt: {campaign_prompt}", file=sys.stderr)

    # Helper to safely get values, assuming they are already parsed JSON if they are objects/arrays
    def safe_get_field(data_dict, field_name, default_value):
        value = data_dict.get(field_name)
        # If it's a string, try to parse it, otherwise return as is or default
        if isinstance(value, str):
            try:
                parsed_value = json.loads(value)
                return parsed_value if parsed_value is not None else default_value
            except json.JSONDecodeError:
                print(f"Warning: Field '{field_name}' is a string but not valid JSON: '{value}'. Using default.", file=sys.stderr)
                return default_value
        return value if value is not None else default_value

    # Initialize with default/fallback values for robustness
    mapped_data = {
        "campaign_id": supabase_creative_data.get("campaign_id"),
        "campaign_prompt": campaign_prompt,
        "placement": safe_get_field(supabase_creative_data, "placement", "social"),
        "dimensions": safe_get_field(supabase_creative_data, "dimensions", {"width": 1080, "height": 1920}),
        "format": safe_get_field(supabase_creative_data, "format", "static"),
        "Canvas": {
            "background": {
                "type": safe_get_field(supabase_creative_data.get("background", {}), "type", "solid"),
                "color": safe_get_field(supabase_creative_data.get("background", {}), "color", "#ffffff"),
                "description": safe_get_field(supabase_creative_data.get("background", {}), "description", ""),
                "image": None # This will be set from imagery.background_image_url
            },
            "layout_grid": safe_get_field(supabase_creative_data, "layout_grid", "free"),
            "bleed_safe_margins": safe_get_field(supabase_creative_data, "bleed_safe_margins", None),
            "Imagery": {
                "background_image_url": None # Will be populated below from the 'imagery' array
            },
            "Text_Blocks": [], # Will be populated below
            "cta_buttons": [], # Will be populated below
            "brand_logo": {}, # Will be populated below
            "brand_colors": [], # Will be populated below
            "slogans": None, # Will be populated below
            "legal_disclaimer": None, # Will be populated below
            "decorative_elements": [] # Will be populated below
        }
    }
    # print(f"Initial mapped_data Canvas structure: {json.dumps(mapped_data['Canvas'], indent=2)}", file=sys.stderr) # Keep commented for production verbosity

    # --- Populate Imagery and Background Image URL ---
    supabase_imagery = safe_get_field(supabase_creative_data, "imagery", [])
    print(f"Processed imagery (type={type(supabase_imagery)}): {supabase_imagery}", file=sys.stderr)
    
    background_image_url = None
    if isinstance(supabase_imagery, list):
        for img_data in supabase_imagery:
            if isinstance(img_data, dict) and img_data.get("type") == "background" and img_data.get("url"):
                background_image_url = img_data["url"]
                break
    
    if background_image_url:
        mapped_data["Canvas"]["Imagery"]["background_image_url"] = background_image_url
        mapped_data["Canvas"]["background"]["image"] = background_image_url # Also assign to canvas background image field
        print(f"Extracted background_image_url from 'imagery' array: {background_image_url}", file=sys.stderr)
    else:
        print("Warning: No 'background' type image URL found in 'imagery' array.", file=sys.stderr)


    # Populate Text_Blocks (from 'text_blocks' column)
    supabase_text_blocks = safe_get_field(supabase_creative_data, "text_blocks", [])
    print(f"Processed text_blocks (type={type(supabase_text_blocks)}): {supabase_text_blocks}", file=sys.stderr)
    for block in supabase_text_blocks:
        if block is not None and isinstance(block, dict):
            mapped_data["Canvas"]["Text_Blocks"].append({
                "font": block.get("font_family", "Inter"),
                "size": block.get("font_size", "medium"),
                "text": block.get("text", ""),
                "color": block.get("color", "#000000"),
                "position": block.get("alignment", "center")
            })
        else:
            print(f"Warning: Skipping invalid Text Block element: {block}", file=sys.stderr)


    # Populate CTA Buttons (from 'cta_buttons' column)
    supabase_cta_buttons = safe_get_field(supabase_creative_data, "cta_buttons", [])
    # NEW: Handle if cta_buttons is a dict (common from Supabase JSONB)
    if isinstance(supabase_cta_buttons, dict):
        supabase_cta_buttons = list(supabase_cta_buttons.values())
        print(f"Converted cta_buttons from dict to list: {supabase_cta_buttons}", file=sys.stderr)
    print(f"Processed cta_buttons (type={type(supabase_cta_buttons)}): {supabase_cta_buttons}", file=sys.stderr)

    for cta in supabase_cta_buttons:
        if cta is not None and isinstance(cta, dict):
            mapped_data["Canvas"]["cta_buttons"].append({
                "text": cta.get("text", "Shop Now"),
                "color": cta.get("text_color", "#ffffff"),
                "position": "bottom-center", # Default position if not specified elsewhere
                "background": cta.get("bg_color", "#007bff"),
                "style": cta.get("style", "primary"),
                "url": cta.get("url", "https://example.com")
            })
        else:
            print(f"Warning: Skipping invalid CTA button element: {cta}", file=sys.stderr)


    # Populate Brand Logo (from 'brand_logo' column)
    supabase_brand_logo = safe_get_field(supabase_creative_data, "brand_logo", {})
    print(f"Processed brand_logo (type={type(supabase_brand_logo)}): {supabase_brand_logo}", file=sys.stderr)
    if isinstance(supabase_brand_logo, dict):
        mapped_data["Canvas"]["brand_logo"] = {
            "url": supabase_brand_logo.get("url", None),
            "text_alt": supabase_brand_logo.get("text_alt", "Brand Logo"),
            "size": "medium", # Default, server.js doesn't specify size here
            "position": "top-left" # Default
        }
    else:
        print(f"Warning: Unexpected type for brand_logo: {type(supabase_brand_logo)}. Using default.", file=sys.stderr)
        mapped_data["Canvas"]["brand_logo"] = {
            "url": None, "text_alt": "Brand Logo", "size": "medium", "position": "top-left"
        }

    # Populate Brand Colors (from 'brand_colors' column)
    supabase_brand_colors = safe_get_field(supabase_creative_data, "brand_colors", [])
    print(f"Processed brand_colors (type={type(supabase_brand_colors)}): {supabase_brand_colors}", file=sys.stderr)
    if isinstance(supabase_brand_colors, list):
        mapped_data["Canvas"]["brand_colors"] = supabase_brand_colors
    else:
        print(f"Warning: Unexpected type for brand_colors: {type(supabase_brand_colors)}. Setting to empty list.", file=sys.stderr)
        mapped_data["Canvas"]["brand_colors"] = []


    # Populate Slogan (from 'slogan' column)
    mapped_data["Canvas"]["slogans"] = safe_get_field(supabase_creative_data, "slogan", None)
    print(f"Processed slogans: {mapped_data['Canvas']['slogans']}", file=sys.stderr)

    # Populate Legal Disclaimer (from 'legal_disclaimer' column)
    mapped_data["Canvas"]["legal_disclaimer"] = safe_get_field(supabase_creative_data, "legal_disclaimer", None)
    print(f"Processed legal_disclaimer: {mapped_data['Canvas']['legal_disclaimer']}", file=sys.stderr)


    # Populate Decorative Elements (from 'decorative_elements' column)
    supabase_decorative_elements = safe_get_field(supabase_creative_data, "decorative_elements", [])
    print(f"Processed decorative_elements (type={type(supabase_decorative_elements)}): {supabase_decorative_elements}", file=sys.stderr)
    if isinstance(supabase_decorative_elements, list):
        for element in supabase_decorative_elements:
            if element is not None and isinstance(element, dict):
                mapped_data["Canvas"]["decorative_elements"].append({
                    "shape_type": element.get("shape_type", "none"),
                    "color": element.get("color", "#cccccc"),
                    "animation": element.get("animation", "subtle")
                })
            else:
                print(f"Warning: Skipping invalid decorative element: {element}", file=sys.stderr)
    else:
        print(f"Warning: Unexpected type for decorative_elements: {type(supabase_decorative_elements)}. Setting to empty list.", file=sys.stderr)
        mapped_data["Canvas"]["decorative_elements"] = []

    print("Mapped schema (Approach-1):", json.dumps(mapped_data, indent=2), file=sys.stderr)
    return {"required_elements": mapped_data}

def post_process_llm_html(llm_generated_html: str, original_width: int, original_height: int) -> str:
    """
    Modifies LLM-generated HTML to ensure responsive scaling within an iframe.
    - Sets .creative-container to use width: 100% and padding-bottom for aspect ratio.
    - Converts absolute pixel positions (left, top, width, height, font-size) of
      .overlay-text and .cta-button to percentages or vw units.
    - Sets .creative-image to use object-fit: contain;
    """
    print("\n--- Post-processing LLM-generated HTML for responsiveness ---", file=sys.stderr)

    if original_width <= 0 or original_height <= 0:
        print("Warning: Original dimensions are invalid. Cannot apply proportional scaling.", file=sys.stderr)
        return llm_generated_html

    # 1. Modify .creative-container CSS and ensure .creative-image CSS is correct
    # Find the <style> block
    style_block_match = re.search(r"<style>(.*?)</style>", llm_generated_html, re.DOTALL)
    
    if style_block_match:
        current_styles = style_block_match.group(1)
        
        # Define the new responsive CSS for creative-container and creative-image
        new_creative_container_css = f"""
        .creative-container {{
            position: relative;
            width: 100%; /* Make it fill the iframe's width */
            padding-bottom: calc(100% * ({original_height} / {original_width})); /* Maintain aspect ratio dynamically */
            overflow: hidden;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            border-radius: 8px;
            background-color: #ffffff;
            transform-origin: top left;
        }}
        """
        # *** MODIFIED: Changed object-fit from 'cover' to 'contain' ***
        creative_image_css = """
        .creative-image {
            position: absolute;
            width: 100%;
            height: 100%;
            object-fit: contain; /* Changed from 'cover' to 'contain' */
            top: 0;
            left: 0;
        }
        """

        # Replace or add .creative-container styles
        if ".creative-container" in current_styles:
            current_styles = re.sub(
                r"\.creative-container\s*\{[^}]*\}",
                new_creative_container_css.strip(),
                current_styles,
                flags=re.DOTALL
            )
        else:
            current_styles += new_creative_container_css

        # Replace or add .creative-image styles
        if ".creative-image" in current_styles:
            current_styles = re.sub(
                r"\.creative-image\s*\{[^}]*\}",
                creative_image_css.strip(),
                current_styles,
                flags=re.DOTALL
            )
        else:
            current_styles += creative_image_css
            
        # Update the HTML with the modified style block
        llm_generated_html = llm_generated_html.replace(style_block_match.group(0), f"<style>{current_styles}</style>")
    else:
        print("Warning: No <style> tag found in LLM-generated HTML. Prepending basic styles.", file=sys.stderr)
        # If no style tag, prepend a basic one in the head
        llm_generated_html = llm_generated_html.replace("<head>", f"<head>\n<style>{new_creative_container_css}\n{creative_image_css}</style>", 1)


    # 2. Convert absolute pixel values to percentages/vw for overlay-text and cta-button
    
    def replace_px_to_percent(match):
        # match.group(1) is the class attribute, match.group(2) is the style content
        element_class = match.group(1)
        style_str = match.group(2)

        new_style_parts = []
        
        # Process position and size properties (left, top, width, height)
        for prop in ['left', 'top', 'width', 'height']:
            # Find property: value; including optional space after colon and before px
            px_match = re.search(rf"{prop}:\s*(\d+(\.\d+)?)\s*px;", style_str)
            if px_match:
                px_val = float(px_match.group(1))
                if prop in ['left', 'width']:
                    percent_val = (px_val / original_width) * 100
                else: # top, height
                    percent_val = (px_val / original_height) * 100
                new_style_parts.append(f"{prop}: {percent_val:.4f}%;")
                # Remove the original px property from style_str to avoid duplicates
                style_str = re.sub(rf"{prop}:\s*\d+(\.\d+)?\s*px;", "", style_str)
            
        # Process font-size property
        font_size_px_match = re.search(r"font-size:\s*(\d+(\.\d+)?)\s*px;", style_str)
        if font_size_px_match:
            font_px_val = float(font_size_px_match.group(1))
            # Convert to vw relative to the original creative width
            font_vw_val = (font_px_val / original_width) * 100
            new_style_parts.append(f"font-size: {font_vw_val:.4f}vw;")
            style_str = re.sub(r"font-size:\s*\d+(\.\d+)?\s*px;", "", style_str)

        # Keep any other original styles that were not processed, split by semicolon
        # and filter out empty strings from potential multiple semicolons
        remaining_styles = [part.strip() for part in style_str.split(';') if part.strip()]
        
        # Combine all parts with proper semicolon separation
        final_style = "; ".join(new_style_parts + remaining_styles).strip()
        
        # Reconstruct the attribute string for the HTML tag
        return f'{element_class} style="{final_style}"'

    # Apply the replacement for elements with class 'overlay-text' or 'cta-button'
    # This regex captures the class attribute group and the style attribute content group.
    # It ensures we only modify elements that have these specific classes.
    llm_generated_html = re.sub(
        r'(class="[^"]*(?:overlay-text|cta-button)[^"]*")\s+style="([^"]*)"',
        replace_px_to_percent,
        llm_generated_html,
        flags=re.DOTALL
    )

    print("Finished post-processing HTML.", file=sys.stderr)
    return llm_generated_html


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
                print(f"Fetched campaign_prompt from DB: '{campaign_prompt_from_db}'", file=sys.stderr)
                campaign_prompt_final = campaign_prompt_from_db
            except Exception as e:
                print(f"Warning: Could not fetch campaign prompt from DB for campaign_id {campaign_id_from_creative}: {e}. Using CLI prompt.", file=sys.stderr)
                # campaign_prompt_final remains args.campaign_prompt_cli

        # Phase 0.1: Map Supabase data to the expected 'required_elements' schema
        # Use the prompt fetched from DB (or CLI fallback) for the mapped data
        creative_data_for_processing = map_supabase_to_required_elements_schema(supabase_creative_data, campaign_prompt_final)

        # This is the actual data payload that will be passed to the LLM prompt
        creative_data = creative_data_for_processing["required_elements"]

        # Extract original creative dimensions for post-processing
        creative_width = creative_data.get("dimensions", {}).get("width", 1080)
        creative_height = creative_data.get("dimensions", {}).get("height", 1920)
        print(f"Detected original creative dimensions for post-processing: {creative_width}x{creative_height}", file=sys.stderr)


        # -------- Build refined prompt for GPT --------
        system_prompt = (
            "You are an expert HTML & CSS ad designer. "
            "Given a JSON object that describes a marketing creative — like background, imagery, text blocks, and CTA buttons — "
            "generate a COMPLETE HTML document. "
            "Prefer relative sizing (percentages, vw/vh) for elements within the main container where possible to ensure responsiveness. "
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

**IMPORTANT: The final creative must be responsive within its container, maintaining the original aspect ratio ({creative_width}x{creative_height}) and scaling its internal elements proportionally.**
**Also, ensure the background image is entirely visible without any cropping, even if that means letterboxing/pillarboxing (empty space) is introduced.**

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

        llm_raw_html = response_text[0]

        # POST-PROCESS the LLM's raw HTML for responsiveness
        final_html = post_process_llm_html(llm_raw_html, creative_width, creative_height)

        # -------- Print to stdout (no file saving) --------
        print(final_html)
        print("\nHTML output successfully sent to stdout.", file=sys.stderr) # Informative message

    except FileNotFoundError as e:
        print(f"Error: {e}. Please ensure all required files and directories exist.", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Data Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()