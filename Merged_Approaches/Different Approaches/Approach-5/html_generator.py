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

# --- Configuration for file paths ---
# We still define these paths for temporary local storage needed for OpenCV/EasyOCR
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'temp_output') # Changed to temp_output
FULL_CREATIVE_IMAGE_NAME = "full_creative_temp.jpg" # Temporary name
CLEAN_BACKGROUND_IMAGE_NAME = "clean_background_temp.jpg" # Temporary name

FULL_CREATIVE_IMAGE_PATH = os.path.join(OUTPUT_DIR, FULL_CREATIVE_IMAGE_NAME)
CLEAN_BACKGROUND_IMAGE_PATH = os.path.join(OUTPUT_DIR, CLEAN_BACKGROUND_IMAGE_NAME)
# FINAL_HTML_NAME and FINAL_HTML_PATH are removed as HTML will be returned directly

REPLICATE_MODEL = "black-forest-labs/flux-kontext-pro"

# Initialize EasyOCR reader globally
try:
    print("Initializing EasyOCR reader (this may download models if not present)...", file=sys.stderr)
    reader = easyocr.Reader(['en'])
    print("EasyOCR reader initialized.", file=sys.stderr)
except Exception as e:
    print(f"Error initializing EasyOCR: {e}", file=sys.stderr)
    print("Please ensure necessary EasyOCR dependencies are met, or try running 'pip install easyocr'", file=sys.stderr)
    sys.exit(1)

# Ensure the temporary output directory exists
os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- Helper Functions ---

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
        response = supabase.table('creatives_duplicate').select(
            'creative_id, campaign_id, placement, dimensions, format, background, imagery, text_blocks, cta_buttons, brand_logo, brand_colors, slogan, legal_disclaimer, decorative_elements'
        ).eq('creative_id', creative_id).single().execute()
        
        data = response.data

        if not data:
            print(f"No creative found with ID: {creative_id}", file=sys.stderr)
            raise ValueError(f"Creative ID {creative_id} not found.")

        print(f"Creative data fetched successfully for ID: {creative_id}", file=sys.stderr)
        print(f"Raw Supabase creative data: {json.dumps(data, indent=2)}", file=sys.stderr)
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
    This version retrieves data directly from the top-level columns.
    """
    print("\n--- Mapping Supabase data to required_elements schema ---", file=sys.stderr)
    print(f"Mapping input - supabase_creative_data type: {type(supabase_creative_data)}, value: {json.dumps(supabase_creative_data, indent=2)}", file=sys.stderr)
    print(f"Mapping input - campaign_prompt: {campaign_prompt}", file=sys.stderr)

    # Helper to safely get values. Supabase should ideally return JSONB columns as dicts/lists.
    def safe_get_field(data_dict, field_name, default_value):
        value = data_dict.get(field_name)
        # Assuming JSONB columns are already parsed by Supabase client into Python dict/list
        # If they come as strings, we would need json.loads, but for direct column access,
        # the client usually handles this. Add a check just in case.
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
            "background": safe_get_field(supabase_creative_data, "background", {"color": "#ffffff", "image": None, "description": ""}),
            "layout_grid": safe_get_field(supabase_creative_data, "layout_grid", "free"),
            "bleed_safe_margins": safe_get_field(supabase_creative_data, "bleed_safe_margins", None),
            "Imagery": {
                "background_image_url": None # This will be populated from the 'imagery' array below
            },
            "Text_Blocks": [], # Populated below
            "cta_buttons": [], # Populated below
            "brand_logo": {}, # Populated below
            "brand_colors": [], # Populated below
            "slogans": None, # Populated below
            "legal_disclaimer": None, # Populated below
            "decorative_elements": [] # Populated below
        }
    }
    print(f"Initial mapped_data Canvas structure: {json.dumps(mapped_data['Canvas'], indent=2)}", file=sys.stderr)

    # --- Populate Imagery and Background Image URL ---
    # The 'imagery' field is an array of objects directly from the column.
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
        # Also update the general background image field if needed for other parts of the script
        mapped_data["Canvas"]["background"]["image"] = background_image_url
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
                "position": block.get("alignment", "center") # Map 'alignment' to 'position'
            })
        else:
            print(f"Warning: Skipping invalid Text Block element: {block}", file=sys.stderr)


    # Populate CTA Buttons (from 'cta_buttons' column)
    supabase_cta_buttons = safe_get_field(supabase_creative_data, "cta_buttons", [])
    print(f"Processed cta_buttons (type={type(supabase_cta_buttons)}): {supabase_cta_buttons}", file=sys.stderr)
    for cta in supabase_cta_buttons:
        if cta is not None and isinstance(cta, dict):
            mapped_data["Canvas"]["cta_buttons"].append({
                "text": cta.get("text", "Shop Now"),
                "color": cta.get("text_color", "#ffffff"),
                "position": "bottom-center", # Assume a default position if not explicit in server.js output
                "background": cta.get("bg_color", "#007bff")
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
            "size": "medium", # Assume default, server.js doesn't specify size here
            "position": "top-left" # Assume default
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
                    "animation": "subtle" # Default, not explicitly in server.js output
                })
            else:
                print(f"Warning: Skipping invalid decorative element: {element}", file=sys.stderr)
    else:
        print(f"Warning: Unexpected type for decorative_elements: {type(supabase_decorative_elements)}. Setting to empty list.", file=sys.stderr)
        mapped_data["Canvas"]["decorative_elements"] = []


    print("Mapped schema:", json.dumps(mapped_data, indent=2), file=sys.stderr)
    return {"required_elements": mapped_data}

# ------------------------------------------------------
# Phase 1: Generate Full Creative Image using Replicate
# ------------------------------------------------------
def generate_full_creative(replicate_client, creative_data):
    """
    Generates the initial full creative image with all elements using a Replicate model.
    This image will then be used for OCR to determine text positions.
    """
    print("\n--- Phase 1: Generating Full Creative Image with AI ---", file=sys.stderr)
    print(f"Input creative_data for Replicate generation: {json.dumps(creative_data, indent=2)}", file=sys.stderr)

    replicate_input = {}
    canvas_data = creative_data.get("Canvas", {})
    print(f"Canvas data extracted for Replicate input: {json.dumps(canvas_data, indent=2)}", file=sys.stderr)


    campaign_prompt = creative_data.get("campaign_prompt", "Generate a marketing creative.")
    main_prompt = f"{campaign_prompt}. "

    dimensions = creative_data.get("dimensions", {"width": 1080, "height": 1920}) # Updated default for consistency
    replicate_input["width"] = dimensions.get("width", 1080)
    replicate_input["height"] = dimensions.get("height", 1920) # Updated default for consistency
    print(f"Replicate dimensions: {replicate_input['width']}x{replicate_input['height']}", file=sys.stderr)


    # Pull background_image_url from the mapped Canvas.Imagery
    background_image_url_from_mapped_schema = canvas_data.get("Imagery", {}).get("background_image_url")
    print(f"Background image URL from mapped schema for Replicate: {background_image_url_from_mapped_schema}", file=sys.stderr)

    if background_image_url_from_mapped_schema:
        replicate_input["image"] = background_image_url_from_mapped_schema
        main_prompt += "Integrate these elements onto the provided background image. "
        print(f"Using background_image_url from mapped schema for AI generation: {background_image_url_from_mapped_schema}", file=sys.stderr)
    elif canvas_data.get("background", {}).get("color"):
        main_prompt += f"Use a background color of {canvas_data['background']['color']}. "
        print(f"Using background color for AI generation: {canvas_data['background']['color']}", file=sys.stderr)
    else:
        main_prompt += "Generate with an appropriate background. "
        print("No specific background image or color. AI will generate background.", file=sys.stderr)


    texts_for_replicate = []
    text_blocks = canvas_data.get("Text_Blocks", [])
    print(f"Text_Blocks for Replicate: {text_blocks}", file=sys.stderr)
    for block in text_blocks:
        texts_for_replicate.append({
            "text": block.get("text", ""), # Use original text for Replicate
            "font_size": get_font_size_px(block.get("size", "medium")),
            "position": block.get("position", "center")
        })
        main_prompt += f"Include '{block.get('text', '')}' text in {block.get('color', 'black')} at {block.get('position', 'center')}. "

    cta_buttons_raw = canvas_data.get("cta_buttons", [])
    if not isinstance(cta_buttons_raw, list):
        cta_buttons = []
    else:
        cta_buttons = cta_buttons_raw
    print(f"CTA Buttons for Replicate: {cta_buttons}", file=sys.stderr)

    for cta in cta_buttons:
        texts_for_replicate.append({
            "text": cta.get("text", ""), # Use original text for Replicate
            "font_size": get_font_size_px("large"),
            "position": cta.get("position", "bottom-center")
        })
        main_prompt += f"Add a call-to-action button with text '{cta.get('text', 'Shop Now')}' and background color {cta.get('background', 'red')} at {cta.get('position', 'bottom-center')}. "

    brand_logo_info = canvas_data.get("brand_logo", {})
    brand_logo_text_alt = brand_logo_info.get("text_alt")
    brand_logo_url = brand_logo_info.get("url") # This URL might not be populated from server.js yet
    print(f"Brand Logo Info for Replicate: {brand_logo_info}", file=sys.stderr)


    if brand_logo_url and isinstance(brand_logo_url, str) and brand_logo_url.startswith("http"):
        main_prompt += f"Integrate a brand logo image visually similar to the one at {brand_logo_url} at {brand_logo_info.get('position', 'top-left')} with {brand_logo_info.get('size', 'medium')} size. "
        print(f"Note: Model '{REPLICATE_MODEL}' interprets logo URL from prompt. Direct logo input not available in current 'image' field.", file=sys.stderr)
    elif brand_logo_text_alt:
        texts_for_replicate.append({
            "text": brand_logo_text_alt, # Use original text for Replicate
            "font_size": get_font_size_px(brand_logo_info.get("size", "medium")),
            "position": brand_logo_info.get("position", "top-left")
        })
        main_prompt += f"Include brand logo text: '{brand_logo_text_alt}' at {brand_logo_info.get('position', 'top-left')}. "


    slogans = canvas_data.get("slogans")
    if slogans and isinstance(slogans, str):
        texts_for_replicate.append({"text": slogans, "font_size": get_font_size_px("medium"), "position": "bottom-center"})
        main_prompt += f"Include the slogan: '{slogans}'. "
    print(f"Slogans for Replicate: {slogans}", file=sys.stderr)


    legal_disclaimer = canvas_data.get("legal_disclaimer")
    if legal_disclaimer and isinstance(legal_disclaimer, str):
        texts_for_replicate.append({"text": legal_disclaimer, "font_size": get_font_size_px("small"), "position": "bottom-right"})
        main_prompt += f"Include a legal disclaimer: '{legal_disclaimer}'. "
    print(f"Legal Disclaimer for Replicate: {legal_disclaimer}", file=sys.stderr)


    brand_colors_list = canvas_data.get("brand_colors", [])
    if isinstance(brand_colors_list, list) and brand_colors_list:
        main_prompt += f"Use brand colors: {', '.join(brand_colors_list)}. "
    print(f"Brand Colors for Replicate: {brand_colors_list}", file=sys.stderr)


    decorative_elements_raw = canvas_data.get("decorative_elements", [])
    if isinstance(decorative_elements_raw, list):
        for element in decorative_elements_raw:
            if element is not None and isinstance(element, dict):
                main_prompt += f"Add a {element.get('shape_type', 'geometric')} decorative element with color {element.get('color', '')} and {element.get('animation', 'subtle')} animation. "
    else:
        print(f"Warning: Unexpected type for decorative_elements: {type(decorative_elements_raw)}. Skipping.", file=sys.stderr)
    print(f"Decorative Elements for Replicate: {decorative_elements_raw}", file=sys.stderr)


    replicate_input["prompt"] = main_prompt.strip()
    replicate_input["texts"] = texts_for_replicate

    print("\n--- Replicate Model Input (Full Creative) ---", file=sys.stderr)
    print(f"Model: {REPLICATE_MODEL}", file=sys.stderr)
    print(f"Input Payload: {json.dumps(replicate_input, indent=2)}", file=sys.stderr)
    print("---------------------------------------------\n", file=sys.stderr)

    try:
        print("Attempting to call replicate_client.run()...", file=sys.stderr)
        replicate_output_object = replicate_client.run(REPLICATE_MODEL, input=replicate_input)
        print(f"replicate_client.run() returned: {replicate_output_object}", file=sys.stderr)
        
        if replicate_output_object is None or not hasattr(replicate_output_object, 'url'):
            raise Exception(f"Replicate model '{REPLICATE_MODEL}' did not return a valid output object with a 'url' attribute. Received: {replicate_output_object}")
        
        output_url = replicate_output_object.url
        
        if not output_url:
            raise Exception(f"Replicate model '{REPLICATE_MODEL}' returned an empty image URL.")
    except Exception as e:
        print(f"Error calling Replicate model '{REPLICATE_MODEL}': {e}", file=sys.stderr)
        raise

    print(f"Replicate returned full creative image URL: {output_url}", file=sys.stderr)

    # Image is downloaded temporarily for OCR, will be deleted later
    if not download_image(output_url, FULL_CREATIVE_IMAGE_PATH):
        raise Exception("Failed to download full creative image for OCR processing.")

    return output_url

# ------------------------------------------------------
# Phase 2: Generate Clean Background Image (NO LONGER USED for *new* generation)
# ------------------------------------------------------
# This function is now simplified to just return the full_creative_url
# and ensure a local copy exists for OCR, consistent with the "no new generation"
# requirement for the clean background.
def generate_clean_background(full_creative_image_url: str):
    """
    This function no longer generates a clean background image via a separate Replicate call.
    It now simply returns the full_creative_image_url as the 'clean' background,
    and ensures this image is available locally for potential use by OpenCV/EasyOCR.
    """
    print("\n--- Phase 2: Using Full Creative Image as 'Clean Background' ---", file=sys.stderr)
    
    # To maintain consistency with the old "clean_background_url" logic, we will download
    # the full creative image to CLEAN_BACKGROUND_IMAGE_PATH if it's not already there.
    # This is primarily for the OCR step that expects a local path.
    if not os.path.exists(CLEAN_BACKGROUND_IMAGE_PATH):
        if not download_image(full_creative_image_url, CLEAN_BACKGROUND_IMAGE_PATH):
            print("Warning: Failed to copy full creative image to CLEAN_BACKGROUND_IMAGE_PATH. This might affect local debugging or subsequent steps relying on this path.", file=sys.stderr)
            
    print(f"Using full creative image URL as clean background: {full_creative_image_url}", file=sys.stderr)
    return full_creative_image_url

# ------------------------------------------------------
# Phase 3: Extract Text Positions using EasyOCR
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

    print(f"Image loaded for OCR: {image_path}", file=sys.stderr)
    results = reader.readtext(img)
    print(f"Raw EasyOCR results: {results}", file=sys.stderr)


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

            # Draw bounding box and text for debugging, this will be saved
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
# Phase 4: Generate HTML with Original Background and OCR Text Positions
# ------------------------------------------------------
def generate_html_with_ocr_layout(final_html_background_url: str, ocr_boxes: list, creative_data: dict):
    """
    Generates the final HTML creative using the background URL gathered from Supabase
    and OCR-detected text positions. It verifies the actual dimensions
    of the generated image to ensure the HTML container matches.
    This function now returns the HTML content as a string.
    """
    print("\n--- Phase 4: Generating Final HTML ---", file=sys.stderr)
    print(f"HTML generation input - final_html_background_url: {final_html_background_url}", file=sys.stderr)
    print(f"HTML generation input - ocr_boxes: {ocr_boxes}", file=sys.stderr)
    print(f"HTML generation input - creative_data dimensions: {creative_data.get('dimensions')}", file=sys.stderr)


    requested_dimensions = creative_data.get("dimensions", {"width": 1080, "height": 1920})
    requested_width = requested_dimensions.get("width", 1080)
    requested_height = requested_dimensions.get("height", 1920)

    # Use the full creative image that was generated by Replicate for dimension verification
    # This image is expected to be present temporarily for OCR
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

    # Using final_html_background_url which should be the URL of the "clean" (or full) image
    if not final_html_background_url:
        print("Warning: final_html_background_url is empty. HTML background will be empty.", file=sys.stderr)
        final_html_background_url = ""

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
        <img class="creative-image" src="{final_html_background_url}" alt="Creative Background">
"""
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
        html_content += f"""        <div class="overlay-text" style="{style}">{text_content}</div>\n"""

    html_content += """    </div>\n</body>\n</html>"""
    
    print("Generated HTML content prepared for output.", file=sys.stderr)
    return html_content

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
        campaign_prompt_from_cli = sys.argv[2] 
        print(f"Received creative_id: {creative_id_arg} and campaign_prompt from CLI: '{campaign_prompt_from_cli}'", file=sys.stderr)

        # Phase 0: Fetch creative data from Supabase (now directly from columns)
        supabase_creative_data = fetch_creative_data_from_supabase(creative_id_arg)
        
        # Determine the campaign_id from the fetched creative data
        campaign_id_from_creative = supabase_creative_data.get("campaign_id")

        campaign_prompt_final = campaign_prompt_from_cli # Default to CLI if DB fetch fails
        if campaign_id_from_creative:
            try:
                # Fetch the *actual* campaign_prompt from the campaigns_duplicate table
                campaign_prompt_from_db = fetch_campaign_prompt_from_supabase(campaign_id_from_creative)
                print(f"Fetched campaign_prompt from DB: '{campaign_prompt_from_db}'", file=sys.stderr)
                campaign_prompt_final = campaign_prompt_from_db
            except Exception as e:
                print(f"Warning: Could not fetch campaign prompt from DB for campaign_id {campaign_id_from_creative}: {e}. Using CLI prompt.", file=sys.stderr)

        # Phase 0.1: Map Supabase data to the expected 'required_elements' schema
        creative_data_for_processing = map_supabase_to_required_elements_schema(supabase_creative_data, campaign_prompt_final)
        
        # Extract the background image URL from the mapped data
        # This is the URL that will be directly used in the HTML for the main background image
        background_image_url_for_html = creative_data_for_processing["required_elements"]["Canvas"]["Imagery"].get("background_image_url")

        if not background_image_url_for_html:
            print("Warning: 'Canvas.Imagery.background_image_url' is missing or malformed in the mapped data. The HTML will use a blank background.", file=sys.stderr)
            # Allow the flow to continue, the HTML generation will handle an empty URL

        # Phase 1: Generate the full creative image using Replicate (for OCR)
        # This function also downloads the image temporarily to FULL_CREATIVE_IMAGE_PATH
        full_creative_url = generate_full_creative(replicate_client, creative_data_for_processing["required_elements"])

        # Phase 2: Generate the clean background image (if needed). 
        # This function now only ensures the full creative image is available locally for OCR.
        clean_background_url = generate_clean_background(full_creative_url)

        # Phase 3: Extract text positions from the full creative image using EasyOCR
        # This step requires the image to be available locally
        ocr_boxes = extract_text_positions(FULL_CREATIVE_IMAGE_PATH)

        # Phase 4: Generate HTML with the clean background URL and OCR positions
        # The HTML is now returned as a string, not saved to a file.
        html_content = generate_html_with_ocr_layout(clean_background_url, ocr_boxes, creative_data_for_processing["required_elements"])

        # Clean up temporary image files
        try:
            if os.path.exists(FULL_CREATIVE_IMAGE_PATH):
                os.remove(FULL_CREATIVE_IMAGE_PATH)
                print(f"Removed temporary file: {FULL_CREATIVE_IMAGE_PATH}", file=sys.stderr)
            if os.path.exists(CLEAN_BACKGROUND_IMAGE_PATH):
                os.remove(CLEAN_BACKGROUND_IMAGE_PATH)
                print(f"Removed temporary file: {CLEAN_BACKGROUND_IMAGE_PATH}", file=sys.stderr)
            # The debug image 'easyocr_debug_image.jpg' remains unless explicitly removed here
        except Exception as e:
            print(f"Error cleaning up temporary files: {e}", file=sys.stderr)


        print("\nMulti-stage creative generation pipeline completed successfully!", file=sys.stderr)
        print(f"Temporary files (if any, e.g., easyocr_debug_image.jpg) are in '{OUTPUT_DIR}'.", file=sys.stderr)
        
        # IMPORTANT: Output the HTML content to stdout so Node.js can capture it
        print(html_content) 

    except FileNotFoundError as e:
        print(f"Error: {e}. Please ensure all required files and directories exist.", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Data Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr) # Print full traceback for unexpected errors
        sys.exit(1)

# Run the main function
if __name__ == "__main__":
    main()