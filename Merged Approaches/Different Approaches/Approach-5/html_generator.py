import os
import requests
import replicate
import json
import cv2
import easyocr
from dotenv import load_dotenv
import sys
from supabase import create_client, Client

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

# --- Configuration for file paths (unchanged) ---
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'output')
FULL_CREATIVE_IMAGE_NAME = "full_creative.jpg"
CLEAN_BACKGROUND_IMAGE_NAME = "clean_background.jpg" # Still used if you want to generate a clean background image
FINAL_HTML_NAME = "final_creative.html"

FULL_CREATIVE_IMAGE_PATH = os.path.join(OUTPUT_DIR, FULL_CREATIVE_IMAGE_NAME)
CLEAN_BACKGROUND_IMAGE_PATH = os.path.join(OUTPUT_DIR, CLEAN_BACKGROUND_IMAGE_NAME)
FINAL_HTML_PATH = os.path.join(OUTPUT_DIR, FINAL_HTML_NAME)

REPLICATE_MODEL = "black-forest-labs/flux-kontext-pro"
REPLICATE_TEXT_REMOVAL_MODEL = "flux-kontext-apps/text-removal" # If you still want to use this model

# Initialize EasyOCR reader globally
try:
    print("Initializing EasyOCR reader (this may download models if not present)...", file=sys.stderr)
    reader = easyocr.Reader(['en'])
    print("EasyOCR reader initialized.", file=sys.stderr)
except Exception as e:
    print(f"Error initializing EasyOCR: {e}", file=sys.stderr)
    print("Please ensure necessary EasyOCR dependencies are met, or try running 'pip install easyocr'", file=sys.stderr)
    sys.exit(1)

os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- Helper Functions (unchanged from previous versions, except for the new ones below) ---

def download_image(image_url, save_path):
    """Downloads an image from a URL and saves it locally."""
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
    print("\n--- Mapping Supabase data to required_elements schema (Python) ---", file=sys.stderr)

    # The full creative spec is stored under the 'creative_spec' column in Supabase
    full_creative_spec = supabase_creative_data.get("creative_spec", {})

    # Access Canvas and other top-level fields from the full_creative_spec
    canvas_data = full_creative_spec.get("Canvas", {})
    dimensions = full_creative_spec.get("dimensions", {"width": 1080, "height": 1080})
    placement = full_creative_spec.get("placement", "social_media")
    format_val = full_creative_spec.get("format", "static")

    mapped_data = {
        "campaign_id": supabase_creative_data.get("campaign_id"),
        "campaign_prompt": campaign_prompt,
        "placement": placement,
        "dimensions": dimensions,
        "format": format_val,
        "Canvas": {
            "background": canvas_data.get("background", {"color": "#ffffff", "image": None, "description": ""}),
            "layout_grid": canvas_data.get("layout_grid", "free"),
            "bleed_safe_margins": canvas_data.get("bleed_safe_margins", ""),
            "Imagery": {
                # CRITICAL FIX: Access background_image_url from canvas_data.Imagery
                "background_image_url": canvas_data.get("Imagery", {}).get("background_image_url")
            },
            "Text_Blocks": canvas_data.get("Text_Blocks", []),
            "cta_buttons": canvas_data.get("cta_buttons", []),
            "brand_logo": canvas_data.get("brand_logo", {
                "url": None,
                "text_alt": "Brand Logo",
                "size": "medium",
                "position": "top-left"
            }),
            "brand_colors": canvas_data.get("brand_colors", []),
            "slogans": canvas_data.get("slogans"),
            "legal_disclaimer": canvas_data.get("legal_disclaimer"),
            "decorative_elements": canvas_data.get("decorative_elements", [])
        }
    }

    # Further normalization for lists
    if not isinstance(mapped_data["Canvas"]["brand_colors"], list):
        if isinstance(mapped_data["Canvas"]["brand_colors"], dict):
            mapped_data["Canvas"]["brand_colors"] = list(mapped_data["Canvas"]["brand_colors"].values())
        else:
            mapped_data["Canvas"]["brand_colors"] = []

    if not isinstance(mapped_data["Canvas"]["decorative_elements"], list):
        mapped_data["Canvas"]["decorative_elements"] = []
    if mapped_data["Canvas"]["decorative_elements"] == "" or mapped_data["Canvas"]["decorative_elements"] is None:
        mapped_data["Canvas"]["decorative_elements"] = []

    print("Mapped schema (Python):", json.dumps(mapped_data, indent=2), file=sys.stderr)
    return {"required_elements": mapped_data} 

# ------------------------------------------------------
# Phase 1: Generate Full Creative Image using Replicate (unchanged)
# ------------------------------------------------------
def generate_full_creative(replicate_client, creative_data):
    """
    Generates the initial full creative image with all elements using a Replicate model.
    This image will then be used for OCR to determine text positions.
    """
    print("\n--- Phase 1: Generating Full Creative Image with AI ---", file=sys.stderr)
    replicate_input = {}
    canvas_data = creative_data.get("Canvas", {})

    campaign_prompt = creative_data.get("campaign_prompt", "Generate a marketing creative.")
    main_prompt = f"{campaign_prompt}. "

    dimensions = creative_data.get("dimensions", {"width": 1080, "height": 1080})
    replicate_input["width"] = dimensions.get("width", 1080)
    replicate_input["height"] = dimensions.get("height", 1080)

    imagery_raw = canvas_data.get("Imagery", {})
    background_image_url_from_json = None

    background_image_url_from_json = imagery_raw.get("background_image_url")
    
    if background_image_url_from_json:
        replicate_input["image"] = background_image_url_from_json
        main_prompt += "Integrate these elements onto the provided background image. "
        print(f"Using background_image_url from JSON for AI generation: {background_image_url_from_json}", file=sys.stderr)
    elif canvas_data.get("background", {}).get("color"):
        main_prompt += f"Use a background color of {canvas_data['background']['color']}. "
    else:
        main_prompt += "Generate with an appropriate background. "

    texts_for_replicate = []
    text_blocks = canvas_data.get("Text_Blocks", [])
    for block in text_blocks:
        processed_text = block.get("text", "")
        sensitive_terms = ["Hollister", "Gilly Hicks", "Abercrombie", "Nike", "Adidas"]
        if any(term.lower() in processed_text.lower() for term in sensitive_terms):
            print(f"Warning: Potentially sensitive term '{processed_text}' detected in Text Block. Generalizing for AI prompt.", file=sys.stderr)
            processed_text = "Apparel Brand Name" 
            
        texts_for_replicate.append({
            "text": block.get("text", ""),
            "font_size": get_font_size_px(block.get("size", "medium")),
            "position": block.get("position", "center")
        })
        main_prompt += f"Include '{processed_text}' text in {block.get('color', 'black')} at {block.get('position', 'center')}. "

    cta_buttons_raw = canvas_data.get("cta_buttons", [])
    if not isinstance(cta_buttons_raw, list):
        cta_buttons = []
    else:
        cta_buttons = cta_buttons_raw

    for cta in cta_buttons:
        processed_cta_text = cta.get("text", "") 
        sensitive_terms = ["Hollister", "Gilly Hicks", "Abercrombie", "Nike", "Adidas"]
        if any(term.lower() in processed_cta_text.lower() for term in sensitive_terms):
            print(f"Warning: Potentially sensitive term '{processed_cta_text}' detected in CTA. Generalizing for AI prompt.", file=sys.stderr)
            processed_cta_text = "Shop Now"
            
        texts_for_replicate.append({
            "text": cta.get("text", ""),
            "font_size": get_font_size_px("large"),
            "position": cta.get("position", "bottom-center")
        })
        main_prompt += f"Add a call-to-action button with text '{processed_cta_text}' and background color {cta.get('background', 'red')} at {cta.get('position', 'bottom-center')}. "

    brand_logo_info = canvas_data.get("brand_logo", {})
    brand_logo_text_alt = brand_logo_info.get("text_alt")
    brand_logo_url = brand_logo_info.get("url") 

    if brand_logo_url and isinstance(brand_logo_url, str) and brand_logo_url.startswith("http"):
        main_prompt += f"Integrate a brand logo image from {brand_logo_url} at {brand_logo_info.get('position', 'top-left')} with {brand_logo_info.get('size', 'medium')} size. "
        print(f"Note: Model '{REPLICATE_MODEL}' interprets logo URL from prompt. Direct logo input not available.", file=sys.stderr)
    elif brand_logo_text_alt:
        processed_brand_name = brand_logo_text_alt
        sensitive_brands = ["Hollister", "Gilly Hicks", "Abercrombie", "Nike", "Adidas"]
        if any(brand.lower() in brand_logo_text_alt.lower() for brand in sensitive_brands):
            print(f"Warning: Potentially sensitive brand name '{brand_logo_text_alt}' detected. Generalizing for AI prompt.", file=sys.stderr)
            processed_brand_name = "Generic Apparel Brand"
            
        texts_for_replicate.append({
            "text": brand_logo_text_alt,
            "font_size": get_font_size_px(brand_logo_info.get("size", "medium")),
            "position": brand_logo_info.get("position", "top-left")
        })
        main_prompt += f"Include brand logo text: '{processed_brand_name}' at {brand_logo_info.get('position', 'top-left')}. "
    elif brand_logo_info.get("logos"): 
        for logo_text in brand_logo_info["logos"]:
            generic_logo_text = logo_text
            texts_for_replicate.append({
                "text": generic_logo_text,
                "font_size": get_font_size_px("medium"),
                "position": "top-left"
            })
            main_prompt += f"Include brand logo text: '{generic_logo_text}'. "

    slogans = canvas_data.get("slogans")
    if slogans and isinstance(slogans, str):
        texts_for_replicate.append({"text": slogans, "font_size": get_font_size_px("medium"), "position": "bottom-center"})
        main_prompt += f"Include the slogan: '{slogans}'. "

    legal_disclaimer = canvas_data.get("legal_disclaimer")
    if legal_disclaimer and isinstance(legal_disclaimer, str):
        texts_for_replicate.append({"text": legal_disclaimer, "font_size": get_font_size_px("small"), "position": "bottom-right"})
        main_prompt += f"Include a legal disclaimer: '{legal_disclaimer}'. "

    brand_colors_list = canvas_data.get("brand_colors", [])
    if isinstance(brand_colors_list, dict): 
        colors_str = []
        if 'primary' in brand_colors_list: colors_str.append(f"primary {brand_colors_list['primary']}")
        if 'accent' in brand_colors_list: colors_str.append(f"accent {brand_colors_list['accent']}")
        if 'secondary' in brand_colors_list: colors_str.append(f"secondary {brand_colors_list['secondary']}")
        if colors_str:
            main_prompt += f"Use brand colors: {', '.join(colors_str)}. "
    elif isinstance(brand_colors_list, list): 
        main_prompt += f"Use brand colors: {', '.join(brand_colors_list)}. "

    decorative_elements_raw = canvas_data.get("decorative_elements", [])
    if isinstance(decorative_elements_raw, list):
        for element in decorative_elements_raw:
            main_prompt += f"Add a {element.get('shape_type', 'geometric')} decorative element with color {element.get('color', '')} and {element.get('animation', 'subtle')} animation. "
    elif isinstance(decorative_elements_raw, str) and decorative_elements_raw.strip() == "":
        pass 
    else:
        print(f"Warning: Unexpected type for decorative_elements: {type(decorative_elements_raw)}. Skipping.", file=sys.stderr)


    replicate_input["prompt"] = main_prompt.strip()
    replicate_input["texts"] = texts_for_replicate

    print("\n--- Replicate Model Input (Full Creative) ---", file=sys.stderr)
    print(f"Model: {REPLICATE_MODEL}", file=sys.stderr)
    print(f"Input Payload: {json.dumps(replicate_input, indent=2)}", file=sys.stderr)
    print("---------------------------------------------\n", file=sys.stderr)

    try:
        replicate_output_object = replicate_client.run(REPLICATE_MODEL, input=replicate_input)
        output_url = replicate_output_object.url
    except Exception as e:
        print(f"Error calling Replicate model '{REPLICATE_MODEL}': {e}", file=sys.stderr)
        raise

    print(f"Replicate returned full creative image URL: {output_url}", file=sys.stderr)

    if not download_image(output_url, FULL_CREATIVE_IMAGE_PATH):
        raise Exception("Failed to download full creative image.")

    return output_url

# ------------------------------------------------------
# Phase 2: Generate Clean Background Image (unchanged, still uses the text removal model)
# ------------------------------------------------------
def generate_clean_background(replicate_client, full_creative_image_url, creative_data):
    """
    Generates a clean background image by re-prompting the model to remove text/branding.
    """
    print("\n--- Phase 2: Generating Clean Background Image ---", file=sys.stderr)
    canvas_data = creative_data.get("Canvas", {})
    dimensions = creative_data.get("dimensions", {"width": 1080, "height": 1080})

    clean_prompt = (
        "remove all text from the image. "
    )

    clean_replicate_input = {
        "input_image": full_creative_image_url,
        "prompt": clean_prompt,
        "width": dimensions.get("width", 1080),
        "height": dimensions.get("height", 1080),
    }

    print("\n--- Replicate Model Input (Clean Background) ---", file=sys.stderr)
    print(f"Model: {REPLICATE_TEXT_REMOVAL_MODEL}", file=sys.stderr)
    print(f"Input Payload: {json.dumps(clean_replicate_input, indent=2)}", file=sys.stderr)
    print("-------------------------------------------------\n", file=sys.stderr)

    try:
        replicate_output_object = replicate_client.run(REPLICATE_TEXT_REMOVAL_MODEL, input=clean_replicate_input)
        clean_background_url = replicate_output_object.url
    except Exception as e:
        print(f"Error calling Replicate model '{REPLICATE_TEXT_REMOVAL_MODEL}': {e}", file=sys.stderr)
        raise

    print(f"Replicate returned clean background image URL: {clean_background_url}", file=sys.stderr)

    if not download_image(clean_background_url, CLEAN_BACKGROUND_IMAGE_PATH):
        raise Exception("Failed to download clean background image.")

    return clean_background_url

# ------------------------------------------------------
# Phase 3: Extract Text Positions using EasyOCR (unchanged from last update)
# ------------------------------------------------------
def extract_text_positions(image_path):
    """
    Extracts text and their bounding box positions from an image using EasyOCR,
    and visualizes these bounding boxes on a debug image.
    """
    print(f"\n--- Phase 3: Extracting text positions with EasyOCR from {image_path} ---", file=sys.stderr)
    img = cv2.imread(image_path)
    if img is None:
        print(f"Error: Could not load image at {image_path} for OCR. Ensure it was downloaded correctly.", file=sys.stderr)
        raise FileNotFoundError(f"Could not load image at {image_path} for OCR.")

    results = reader.readtext(img)
    
    ocr_boxes = []
    debug_img = img.copy() 

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

            cv2.rectangle(debug_img, (x, y), (x + width, y + height), (0, 255, 0), 2)
            cv2.putText(debug_img, f"{text.strip()} ({conf:.2f})", (x, y - 5), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 1, cv2.LINE_AA)

    ocr_boxes.sort(key=lambda b: (b['y'], b['x']))

    debug_output_path = os.path.join(OUTPUT_DIR, "easyocr_debug_image.jpg")
    cv2.imwrite(debug_output_path, debug_img)
    print(f"EasyOCR debug image with bounding boxes saved to {debug_output_path}", file=sys.stderr)

    print("Detected text elements (from EasyOCR):", ocr_boxes, file=sys.stderr)
    if not ocr_boxes:
        print("No text detected by EasyOCR after filtering.", file=sys.stderr)
    return ocr_boxes

# ------------------------------------------------------
# Phase 4: Generate HTML with Clean Background and OCR Text Positions (unchanged from last update)
# ------------------------------------------------------
def generate_html_with_ocr_layout(background_image_url_from_json, ocr_boxes, creative_data):
    """
    Generates the final HTML creative using the background URL from JSON
    and OCR-detected text positions. It now verifies the actual dimensions
    of the generated image to ensure the HTML container matches.
    """
    print("\n--- Phase 4: Generating Final HTML ---", file=sys.stderr)
    
    requested_dimensions = creative_data.get("dimensions", {"width": 1080, "height": 1080})
    requested_width = requested_dimensions.get("width", 1080)
    requested_height = requested_dimensions.get("height", 1080)

    actual_img = cv2.imread(FULL_CREATIVE_IMAGE_PATH)
    if actual_img is None:
        print(f"Warning: Could not load the generated image at {FULL_CREATIVE_IMAGE_PATH} to verify dimensions. Using requested dimensions for HTML.", file=sys.stderr)
        actual_creative_height = requested_height
        actual_creative_width = requested_width
    else:
        actual_creative_height, actual_creative_width, _ = actual_img.shape
        print(f"Requested creative dimensions (from JSON): {requested_width}x{requested_height}px", file=sys.stderr)
        print(f"Actual AI-generated image dimensions (from {FULL_CREATIVE_IMAGE_NAME}): {actual_creative_width}x{actual_creative_height}px", file=sys.stderr)

        if actual_creative_width != requested_width or actual_creative_height != requested_height:
            print(f"Dimension Mismatch: AI generated image ({actual_creative_width}x{actual_creative_height}) differs from requested ({requested_width}x{requested_height}). HTML container will use actual dimensions.", file=sys.stderr)
        
    creative_width = actual_creative_width
    creative_height = actual_creative_height

    if not background_image_url_from_json:
        print("Warning: background_image_url not found in JSON. HTML background will be empty.", file=sys.stderr)
        background_image_url_from_json = ""

    with open(FINAL_HTML_PATH, 'w') as f:
        f.write(f"""<!DOCTYPE html>
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
            width: {creative_width}px;
            height: {creative_height}px;
            overflow: hidden;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            border-radius: 8px;
            background-color: #ffffff;
        }}
        .creative-image {{
            position: absolute;
            width: 100%;
            height: 100%;
            object-fit: cover;
            top: 0;
            left: 0;
        }}
        .overlay-text {{
            position: absolute;
            font-weight: bold;
            color: #000000;
            background: rgba(255, 255, 255, 0.7);
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
    </style>
</head>
<body>
    <div class="creative-container">
        <img class="creative-image" src="{background_image_url_from_json}" alt="Creative Background">
""")
        for box in ocr_boxes:
            text_content = box['text'] 

            base_font_size = box['height'] * 0.9 
            estimated_chars_per_line = box['width'] / (base_font_size * 0.6) if base_font_size * 0.6 > 0 else len(text_content)
            
            if len(text_content) > estimated_chars_per_line * 1.2 and estimated_chars_per_line > 0:
                scaling_factor = box['width'] / (len(text_content) * base_font_size * 0.6) if (len(text_content) * base_font_size * 0.6) > 0 else 1
                font_size = base_font_size * scaling_factor * 0.9
            else:
                font_size = base_font_size
            
            font_size = max(10, min(80, font_size))

            html_box_buffer_x = 10
            html_box_buffer_y = 8

            left_pos = max(0, box['x'] - (html_box_buffer_x // 2))
            top_pos = max(0, box['y'] - (html_box_buffer_y // 2))
            
            width_val = max(20, box['width'] + html_box_buffer_x) 
            height_val = max(20, box['height'] + html_box_buffer_y)
            
            width_val = min(width_val, creative_width - left_pos)
            height_val = min(height_val, creative_height - top_pos)

            style = (f"left: {left_pos}px; top: {top_pos}px; "
                     f"width: {width_val}px; height: {height_val}px; "
                     f"font-size: {font_size}px;")
            f.write(f"""        <div class="overlay-text" style="{style}">{text_content}</div>\n""")

        f.write("""    </div>\n</body>\n</html>""")
    print(f"Generated HTML saved to {FINAL_HTML_PATH}", file=sys.stderr)

# ------------------------------------------------------
# Main Orchestration Process (REVISED to accept arguments and fetch from Supabase)
# ------------------------------------------------------
def main():
    try:
        # Validate Replicate API Token
        REPLICATE_API_TOKEN = os.getenv("REPLICATE_API_TOKEN")
        if not REPLICATE_API_TOKEN:
            print("Error: REPLICATE_API_TOKEN environment variable is not set.", file=sys.stderr)
            sys.exit(1)
        replicate_client = replicate.Client(api_token=REPLICATE_API_TOKEN)
        print("Replicate client initialized.", file=sys.stderr)

        # Expect creative_id and campaign_prompt as command-line arguments
        if len(sys.argv) < 3:
            print("Usage: python creative_html_generator.py <creative_id> <campaign_prompt>", file=sys.stderr)
            sys.exit(1)
        
        creative_id_arg = sys.argv[1]
        # The campaign_prompt_arg from sys.argv[2] can be considered a *fallback*
        # or the initial prompt for AI. For structured data, we fetch from DB.
        campaign_prompt_from_cli = sys.argv[2] 
        print(f"Received creative_id: {creative_id_arg} and campaign_prompt from CLI: '{campaign_prompt_from_cli}'", file=sys.stderr)

        # Phase 0: Fetch creative data from Supabase
        supabase_creative_data = fetch_creative_data_from_supabase(creative_id_arg)
        
        # Determine the campaign_id from the fetched creative data
        campaign_id_from_creative = supabase_creative_data.get("campaign_id")

        campaign_prompt_from_db = campaign_prompt_from_cli # Default to CLI if DB fetch fails
        if campaign_id_from_creative:
            try:
                # Fetch the *actual* campaign_prompt from the campaigns_duplicate table
                campaign_prompt_from_db = fetch_campaign_prompt_from_supabase(campaign_id_from_creative)
                print(f"Fetched campaign_prompt from DB: '{campaign_prompt_from_db}'", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Could not fetch campaign prompt from DB for campaign_id {campaign_id_from_creative}: {e}. Using CLI prompt.", file=sys.stderr)
                # campaign_prompt_from_db remains campaign_prompt_from_cli

        # Phase 0.1: Map Supabase data to the expected 'required_elements' schema
        # Use the prompt fetched from DB (or CLI fallback) for the mapped data
        creative_data_for_processing = map_supabase_to_required_elements_schema(supabase_creative_data, campaign_prompt_from_db)
        
        # Extract the background image URL from the mapped data
        background_image_url_for_html = creative_data_for_processing["required_elements"]["Canvas"]["Imagery"].get("background_image_url")

        if not background_image_url_for_html:
            print("Warning: 'Canvas.Imagery.background_image_url' is missing or malformed in the mapped data. The HTML will use a blank background.", file=sys.stderr)
            # Allow the flow to continue, the HTML generation will handle an empty URL

        # Phase 1: Generate the full creative image using Replicate (for OCR)
        full_creative_url = generate_full_creative(replicate_client, creative_data_for_processing["required_elements"])

        # Phase 2: Generate the clean background image (if needed)
        clean_background_url = generate_clean_background(replicate_client, full_creative_url, creative_data_for_processing["required_elements"])

        # Phase 3: Extract text positions from the full creative image using EasyOCR
        ocr_boxes = extract_text_positions(FULL_CREATIVE_IMAGE_PATH)

        # Phase 4: Generate HTML with the clean background and OCR positions
        generate_html_with_ocr_layout(clean_background_url, ocr_boxes, creative_data_for_processing["required_elements"])

        print("\nMulti-stage creative generation pipeline completed successfully!", file=sys.stderr)
        print(f"Check {OUTPUT_DIR} for '{FULL_CREATIVE_IMAGE_NAME}', 'easyocr_debug_image.jpg', '{CLEAN_BACKGROUND_IMAGE_NAME}', and '{FINAL_HTML_NAME}'.", file=sys.stderr)
        
        # IMPORTANT: Output the HTML content to stdout so Node.js can capture it
        with open(FINAL_HTML_PATH, 'r') as f:
            html_content = f.read()
            # Removed the header
            print(html_content) # Print to stdout for Node.js to capture

    except FileNotFoundError as e:
        print(f"Error: {e}. Please ensure all required files and directories exist.", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Data Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        sys.exit(1)

# Run the main function
if __name__ == "__main__":
    main()