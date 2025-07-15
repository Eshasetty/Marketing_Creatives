import os
import requests
import json
import cv2
import easyocr
import numpy as np
from dotenv import load_dotenv
import sys
from supabase import create_client, Client
import io

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

# Initialize EasyOCR reader globally
try:
    print("Initializing EasyOCR reader (this may download models if not present)...", file=sys.stderr)
    # Ensure EasyOCR uses the appropriate backend and that models are available
    reader = easyocr.Reader(['en'])
    print("EasyOCR reader initialized.", file=sys.stderr)
except Exception as e:
    print(f"Error initializing EasyOCR: {e}", file=sys.stderr)
    print("Please ensure necessary EasyOCR dependencies are met, or try running 'pip install easyocr'", file=sys.stderr)
    sys.exit(1)

# --- Helper Functions ---

def download_image_to_memory(image_url):
    """Downloads an image from a URL and returns it as a bytes object."""
    print(f"Downloading image from {image_url} to memory...", file=sys.stderr)
    try:
        response = requests.get(image_url)
        response.raise_for_status()
        print(f"Image downloaded from {image_url}", file=sys.stderr)
        return io.BytesIO(response.content)
    except requests.exceptions.RequestException as e:
        print(f"Failed to download image from {image_url}: {e}", file=sys.stderr)
        return None

def get_font_size_px(size_str):
    """Converts a descriptive font size string to an approximate pixel value."""
    size_map = {
        "small": 20, "medium": 30, "large": 45,
        "x-large": 60, "xx-large": 80, "xxx-large": 100
    }
    return size_map.get(size_str.lower(), 30)

# --- Supabase Fetching and Mapping ---

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
    """
    print("\n--- Mapping Supabase data to required_elements schema ---", file=sys.stderr)
    # print(f"Mapping input - supabase_creative_data type: {type(supabase_creative_data)}, value: {json.dumps(supabase_creative_data, indent=2)}", file=sys.stderr)
    print(f"Mapping input - campaign_prompt: {campaign_prompt}", file=sys.stderr)

    # Helper to safely get values, assuming they are already parsed JSON if they are objects/arrays
    def safe_get_field(data_dict, field_name, default_value):
        value = data_dict.get(field_name)
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
                "color": safe_get_field(supabase_creative_data.get("background", {}), "color", "#ffffff"),
                "image": None # This will be set from imagery.background_image_url
            },
            "layout_grid": safe_get_field(supabase_creative_data, "layout_grid", "free"),
            "bleed_safe_margins": safe_get_field(supabase_creative_data, "bleed_safe_margins", None),
            "Imagery": {
                "background_image_url": None, # Will be populated below from the 'imagery' array
                "full_poster_image_url": None # To store the full AI-generated image URL
            },
            "Text_Blocks": [],
            "cta_buttons": [],
            "brand_logo": {},
            "brand_colors": [],
            "slogans": None,
            "legal_disclaimer": None,
            "decorative_elements": []
        }
    }
    # print(f"Initial mapped_data Canvas structure: {json.dumps(mapped_data['Canvas'], indent=2)}", file=sys.stderr) # Keep commented for production verbosity

    # --- Populate Imagery and Background Image URL ---
    supabase_imagery = safe_get_field(supabase_creative_data, "imagery", [])
    print(f"Processed imagery (type={type(supabase_imagery)}): {supabase_imagery}", file=sys.stderr)
    
    background_image_url = None
    full_poster_image_url = None # Variable to hold the URL of the full AI-generated poster

    if isinstance(supabase_imagery, list):
        for img_data in supabase_imagery:
            if isinstance(img_data, dict) and img_data.get("url"):
                if img_data.get("type") == "background":
                    background_image_url = img_data["url"]
                    print(f"Extracted background_image_url from 'imagery' array: {background_image_url}", file=sys.stderr)
                elif img_data.get("type") == "poster": # Extract the full poster image URL
                    full_poster_image_url = img_data["url"]
                    print(f"Extracted full_poster_image_url from 'imagery' array: {full_poster_image_url}", file=sys.stderr)
    
    if background_image_url:
        mapped_data["Canvas"]["Imagery"]["background_image_url"] = background_image_url
        mapped_data["Canvas"]["background"]["image"] = background_image_url
    else:
        print("Warning: No 'background' type image URL found in 'imagery' array for HTML background.", file=sys.stderr)

    if full_poster_image_url:
        mapped_data["Canvas"]["Imagery"]["full_poster_image_url"] = full_poster_image_url
    else:
        print("Warning: No 'poster' type image URL found in 'imagery' array. OCR on AI-generated image may fail.", file=sys.stderr)


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


    # Populate CTA Buttons (from 'cta_buttons' column) - Robust handling for dict/list
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
                "background": cta.get("bg_color", "#007bff"),
                "url": cta.get("url", "#")
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
            "size": "medium",
            "position": "top-left"
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
                    "animation": "subtle"
                })
            else:
                print(f"Warning: Skipping invalid decorative element: {element}", file=sys.stderr)
    else:
        print(f"Warning: Unexpected type for decorative_elements: {type(supabase_decorative_elements)}. Setting to empty list.", file=sys.stderr)
        mapped_data["Canvas"]["decorative_elements"] = []

    print("Mapped schema:", json.dumps(mapped_data, indent=2), file=sys.stderr)
    return {"required_elements": mapped_data}

# ------------------------------------------------------
# Phase 3: Extract Text Positions using EasyOCR
# ------------------------------------------------------
def extract_text_positions(image_bytes_io):
    """
    Extracts text and their bounding box positions from an image provided as bytes (in-memory)
    using EasyOCR. Uses cv2.imdecode as requested.
    """
    print(f"\n--- Phase 3: Extracting text positions with EasyOCR from in-memory image ---", file=sys.stderr)
    
    # Read the image from bytes in memory using cv2.imdecode
    image_bytes_io.seek(0) # Ensure the stream is at the beginning
    file_bytes = image_bytes_io.read()
    np_array = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(np_array, cv2.IMREAD_COLOR)

    if img is None:
        print(f"Error: Could not decode image from in-memory buffer for OCR.", file=sys.stderr)
        raise ValueError(f"Could not decode image from in-memory buffer for OCR.")

    print(f"Image loaded into memory for OCR (dimensions: {img.shape[1]}x{img.shape[0]}px).", file=sys.stderr)
    results = reader.readtext(img)
    print(f"Raw EasyOCR results: {results}", file=sys.stderr)

    ocr_boxes = []
    for (bbox, text, conf) in results:
        x_coords = [p[0] for p in bbox]
        y_coords = [p[1] for p in bbox]

        x = int(min(x_coords))
        y = int(min(y_coords))
        width = int(max(x_coords) - min(x_coords))
        height = int(max(y_coords) - min(y_coords))

        if conf > 0.6 and text.strip():
            ocr_boxes.append({
                'text': text.strip(),
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'conf': conf
            })

    ocr_boxes.sort(key=lambda b: (b['y'], b['x']))

    print("Detected text elements (from EasyOCR):", ocr_boxes, file=sys.stderr)
    if not ocr_boxes:
        print("No text detected by EasyOCR after filtering.", file=sys.stderr)
    return ocr_boxes

# ------------------------------------------------------
# Phase 4: Generate HTML with Original Background and OCR Text Positions
# ------------------------------------------------------
def generate_html_with_ocr_layout(final_html_background_url: str, ocr_boxes: list, mapped_creative_data: dict, full_creative_image_url: str):
    """
    Generates the final HTML creative as a string.
    It uses the background URL gathered from Supabase and OCR-detected text positions.
    It fetches the dimensions of the AI-generated image directly from its URL using cv2.imdecode.
    """
    print("\n--- Phase 4: Generating Final HTML ---", file=sys.stderr)
    print(f"HTML generation input - final_html_background_url: {final_html_background_url}", file=sys.stderr)
    print(f"HTML generation input - ocr_boxes: {ocr_boxes}", file=sys.stderr)
    print(f"HTML generation input - creative_data dimensions: {mapped_creative_data.get('dimensions')}", file=sys.stderr)
    print(f"HTML generation input - full_creative_image_url (for dimensions): {full_creative_image_url}", file=sys.stderr)

    requested_dimensions = mapped_creative_data.get("dimensions", {"width": 1080, "height": 1920})
    actual_creative_width = requested_dimensions.get("width", 1080)
    actual_creative_height = requested_dimensions.get("height", 1920)

    # Attempt to get actual dimensions of the AI-generated image from its URL using cv2.imdecode
    try:
        if full_creative_image_url:
            print(f"Fetching dimensions from AI-generated image URL: {full_creative_image_url}", file=sys.stderr)
            image_data_buffer = download_image_to_memory(full_creative_image_url)
            if image_data_buffer:
                image_data_buffer.seek(0) # Crucial to reset stream position
                np_array_for_dims = np.frombuffer(image_data_buffer.read(), np.uint8)
                img_for_dims = cv2.imdecode(np_array_for_dims, cv2.IMREAD_COLOR)
                if img_for_dims is not None:
                    actual_creative_height, actual_creative_width, _ = img_for_dims.shape
                    print(f"Actual AI-generated image dimensions (from URL): {actual_creative_width}x{actual_creative_height}px", file=sys.stderr)
                else:
                    print(f"Warning: Could not decode AI-generated image from URL to verify dimensions. Using requested dimensions.", file=sys.stderr)
            else:
                print(f"Warning: Failed to download AI-generated image from URL to verify dimensions. Using requested dimensions.", file=sys.stderr)
        else:
            print("Warning: No full creative image URL provided for dimension verification. Using requested dimensions.", file=sys.stderr)
    except Exception as e:
        print(f"Error while fetching AI-generated image dimensions: {e}. Using requested dimensions.", file=sys.stderr)

    creative_width = actual_creative_width
    creative_height = actual_creative_height

    if not final_html_background_url:
        print("Warning: background_image_url not found in JSON. HTML background will be empty.", file=sys.stderr)
        final_html_background_url = "" # Ensure it's an empty string if None

    # Prepare CTA details for matching
    cta_details_map = {}
    cta_buttons = mapped_creative_data["Canvas"].get("cta_buttons", [])
    for cta in cta_buttons:
        if cta.get("text"):
            # Store details with normalized text as key for easy lookup
            cta_details_map[cta["text"].lower().strip()] = cta
    print(f"CTA Details Map: {cta_details_map}", file=sys.stderr)


    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>Marketing Creative</title>
    <style>
        body {{
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background-color: #f0f0f0;
            font-family: Arial, sans-serif;
        }}
        .creative-container {{
            position: relative;
            width: 100%; /* Make it fill the iframe's width */
            padding-bottom: calc(100% * ({creative_height} / {creative_width})); /* Maintain aspect ratio dynamically */
            /* OR, for a fixed 3:4 aspect ratio, you could use: padding-bottom: 133.33%; */
            overflow: hidden;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            border-radius: 8px;
            background-color: #ffffff;
            /* Ensure children respect the padded container */
            transform-origin: top left;
        }}
        .creative-image {{
            position: absolute;
            width: 100%;
            height: 100%;
            object-fit: cover; /* or contain, depending on desired image fitting */
            top: 0;
            left: 0;
        }}
        .overlay-text {{
            position: absolute;
            font-weight: bold;
            color: #000000;
            background: transparent; /* Keep background for visibility for now */
            padding: 2px 5px;
            border-radius: 3px;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            word-wrap: break-word;
            overflow-wrap: break-word;
            white-space: normal;
            line-height: 1.2;
            cursor: default;
        }}
        /* CTA Button Specific Styles */
        .cta-button {{
            position: absolute;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            text-decoration: none; /* Remove underline */
            padding: 8px 15px; /* Adjust padding as needed */
            border-radius: 5px; /* Slightly rounded corners */
            white-space: nowrap; /* Keep button text on one line */
            box-sizing: border-box;
            overflow: hidden; /* Hide overflow text */
            text-overflow: ellipsis; /* Add ellipsis for overflow */
            cursor: pointer;
            transition: background-color 0.3s ease; /* Smooth hover effect */
        }}
        .cta-button:hover {{
            opacity: 0.9;
        }}
    </style>
</head>
<body>
    <div class="creative-container">
        <img class="creative-image" src="{final_html_background_url}" alt="Creative Background">
"""
    for box in ocr_boxes:
        text_content = box['text']
        normalized_ocr_text = text_content.lower().strip()
        is_cta = False
        cta_url = "#"
        cta_bg_color = "#007bff"
        cta_text_color = "#ffffff"

        # Check if this OCR text matches any defined CTA
        for cta_text_key, cta_details in cta_details_map.items():
            # Using 'in' for partial matching and flexibility
            if cta_text_key in normalized_ocr_text or normalized_ocr_text in cta_text_key:
                is_cta = True
                cta_url = cta_details.get("url", "#")
                cta_bg_color = cta_details.get("background", "#007bff")
                cta_text_color = cta_details.get("color", "#ffffff")
                print(f"Matched OCR text '{text_content}' with CTA '{cta_text_key}'", file=sys.stderr)
                break
        
        base_font_size = box['height'] * 0.9
        estimated_chars_per_line = box['width'] / (base_font_size * 0.6) if (base_font_size * 0.6) > 0 else len(text_content)

        if len(text_content) > estimated_chars_per_line * 1.2 and estimated_chars_per_line > 0:
            scaling_factor = box['width'] / (len(text_content) * base_font_size * 0.6) if (len(text_content) * base_font_size * 0.6) > 0 else 1
            font_size = base_font_size * scaling_factor * 0.9
        else:
            font_size = base_font_size

        font_size = max(10, min(80, font_size)) # Clamp font size

        # Add some buffer to the detected OCR box for better visual appeal
        html_box_buffer_x = 10
        html_box_buffer_y = 8

        left_pos = max(0, box['x'] - (html_box_buffer_x // 2))
        top_pos = max(0, box['y'] - (html_box_buffer_y // 2))

        width_val = max(20, box['width'] + html_box_buffer_x)
        height_val = max(20, box['height'] + html_box_buffer_y)

        # Ensure elements don't go outside the creative container
        width_val = min(width_val, creative_width - left_pos)
        height_val = min(height_val, creative_height - top_pos)

        # Convert pixel values to percentages relative to the creative_width and creative_height
        # Ensure creative_width and creative_height are not zero to avoid division by zero
        current_creative_width = creative_width if creative_width > 0 else 1
        current_creative_height = creative_height if creative_height > 0 else 1

        left_percent = (left_pos / current_creative_width) * 100
        top_percent = (top_pos / current_creative_height) * 100
        width_percent = (width_val / current_creative_width) * 100
        height_percent = (height_val / current_creative_height) * 100

        # Font size often needs to be relative to the width for responsive scaling
        # Let's try `vw` based on the creative container's effective width.
        font_size_vw = (font_size / current_creative_width) * 100 # Convert absolute px font size to vw

        if is_cta:
            style = (f"left: {left_percent}%; top: {top_percent}%; "
                     f"width: {width_percent}%; height: {height_percent}%; "
                     f"font-size: {font_size_vw}vw; " # Use vw for font size
                     f"background-color: {cta_bg_color}; color: {cta_text_color};")
            html_content += f"""        <a href="{cta_url}" class="cta-button" style="{style}" data-x="{box['x']}" data-y="{box['y']}">{text_content}</a>\n"""
        else:
            style = (f"left: {left_percent}%; top: {top_percent}%; "
                     f"width: {width_percent}%; height: {height_percent}%; "
                     f"font-size: {font_size_vw}vw;") # Use vw for font size
            html_content += f"""        <div class="overlay-text" style="{style}" data-x="{box['x']}" data-y="{box['y']}">{text_content}</div>\n"""

    html_content += """    </div>\n</body>\n</html>"""
    print("Generated HTML content string.", file=sys.stderr)
    return html_content

# Rest of your code (main function, etc.) remains unchanged.

# ------------------------------------------------------
# Main Orchestration Process
# ------------------------------------------------------
def main():
    try:
        # Expect creative_id and campaign_prompt as command-line argument.
        if len(sys.argv) < 3:
            print("Usage: python html_generator.py <creative_id> <campaign_prompt>", file=sys.stderr)
            sys.exit(1)

        creative_id_arg = sys.argv[1]
        campaign_prompt_from_cli = sys.argv[2] # Capture campaign_prompt from CLI
        print(f"Received creative_id: {creative_id_arg} and campaign_prompt from CLI: '{campaign_prompt_from_cli}'", file=sys.stderr)

        # Phase 0: Fetch creative data from Supabase
        print("Starting Phase 0: Fetch creative data from Supabase.", file=sys.stderr)
        supabase_creative_data = fetch_creative_data_from_supabase(creative_id_arg)
        print(f"Completed Phase 0. supabase_creative_data is type: {type(supabase_creative_data)}", file=sys.stderr)

        # Determine the campaign_id from the fetched creative data
        print("Extracting campaign_id from creative data.", file=sys.stderr)
        campaign_id_from_creative = supabase_creative_data.get("campaign_id")
        print(f"campaign_id_from_creative: {campaign_id_from_creative}", file=sys.stderr)

        campaign_prompt_to_use = campaign_prompt_from_cli # Default to CLI if DB fetch fails
        if campaign_id_from_creative:
            try:
                print("Attempting to fetch campaign prompt from DB.", file=sys.stderr)
                # Fetch the *actual* campaign_prompt from the campaigns_duplicate table
                campaign_prompt_from_db = fetch_campaign_prompt_from_supabase(campaign_id_from_creative)
                if campaign_prompt_from_db: # Use DB prompt if available
                    campaign_prompt_to_use = campaign_prompt_from_db
                print(f"Fetched campaign_prompt from DB: '{campaign_prompt_from_db}' (Using: '{campaign_prompt_to_use}')", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Could not fetch campaign prompt from DB for campaign_id {campaign_id_from_creative}: {e}. Using CLI prompt.", file=sys.stderr)
        else:
            print("Warning: campaign_id not found in creative data. Cannot fetch campaign prompt from DB. Using CLI prompt.", file=sys.stderr)

        # Phase 0.1: Map Supabase data to the expected 'required_elements' schema
        print("Starting Phase 0.1: Map Supabase data to required_elements schema.", file=sys.stderr)
        creative_data_for_processing = map_supabase_to_required_elements_schema(supabase_creative_data, campaign_prompt_to_use)
        print(f"Completed Phase 0.1. creative_data_for_processing is type: {type(creative_data_for_processing)}", file=sys.stderr)
        # print(f"creative_data_for_processing content: {json.dumps(creative_data_for_processing, indent=2)}", file=sys.stderr) # Keep commented for production verbosity


        # Extract the background image URL for HTML
        print("Extracting background_image_url for HTML.", file=sys.stderr)
        background_image_url_for_html = creative_data_for_processing["required_elements"]["Canvas"]["Imagery"].get("background_image_url")
        print(f"background_image_url_for_html: {background_image_url_for_html}", file=sys.stderr)

        # Extract the full creative image URL (type: "poster") for OCR and dimension calculation
        print("Extracting full_creative_url (type: 'poster') for OCR and dimensions.", file=sys.stderr)
        full_creative_url = creative_data_for_processing["required_elements"]["Canvas"]["Imagery"].get("full_poster_image_url")
        print(f"full_creative_url from Supabase (for OCR): {full_creative_url}", file=sys.stderr)


        if not background_image_url_for_html:
            print("Warning: 'Canvas.Imagery.background_image_url' is missing or malformed in the mapped data. The HTML will use a blank background.", file=sys.stderr)
            # Allow the flow to continue, the HTML generation will handle an empty URL
        
        if not full_creative_url:
            raise ValueError("Error: Full creative image URL (type: 'poster') not found in Supabase data. Cannot perform OCR or get accurate dimensions.")


        # Phase 1: Retrieve and Download the full creative image (for OCR)
        print("Starting Phase 1 (Retrieve): Downloading full creative image from Supabase for OCR.", file=sys.stderr)
        full_creative_image_bytes = download_image_to_memory(full_creative_url)
        if not full_creative_image_bytes:
            raise Exception(f"Failed to download full creative image from {full_creative_url} to memory for OCR.")
        print("Full creative image downloaded to memory.", file=sys.stderr)

        # Phase 3: Extract text positions from the FULL creative image (from memory) using EasyOCR
        print("Starting Phase 3: Extract text positions using EasyOCR.", file=sys.stderr)
        ocr_boxes = extract_text_positions(full_creative_image_bytes)
        print(f"Completed Phase 3. Number of OCR boxes: {len(ocr_boxes)}", file=sys.stderr)


        # Phase 4: Generate HTML with the ORIGINAL background image URL and OCR positions
        print("Starting Phase 4: Generate HTML.", file=sys.stderr)
        html_content = generate_html_with_ocr_layout(background_image_url_for_html, ocr_boxes, creative_data_for_processing["required_elements"], full_creative_url)
        print("Completed Phase 4. HTML generation finished.", file=sys.stderr)


        print("\n✅ Multi-stage creative generation pipeline completed successfully!", file=sys.stderr)

        # IMPORTANT: Output the HTML content to stdout so Node.js can capture it
        print("\n--- Generated HTML Content ---", file=sys.stderr)
        print(html_content) # Print to stdout for Node.js to capture

    except FileNotFoundError as e:
        print(f"Error: {e}. Please ensure all required files and directories exist.", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Data Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        # Print the full traceback for more detailed debugging
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

# Run the main function
if __name__ == "__main__":
    main()