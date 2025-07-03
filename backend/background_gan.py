import openai
import base64
import requests
import os
from dotenv import load_dotenv
from datetime import datetime

# Load API Key
load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")

# Load your image
image_path = "/Users/eshasetty/Documents/Niti AI/poster_total/backend/hollister_posters (1)/Screenshot 2025-07-02 at 10.54.41 AM.png"  # 👈 Replace with your image path
with open(image_path, "rb") as f:
    image_b64 = base64.b64encode(f.read()).decode("utf-8")

# Step 1: Generate background-only prompt
response = openai.chat.completions.create(
    model="gpt-3.5-turbo",
    messages=[
    {
        "role": "user",
        "content": [
            { "type": "text", "text": "Describe only the background of this image for regenerating it." },
            { "type": "image_url", "image_url": { "url": f"data:image/jpeg;base64,{image_b64}" } }
        ]
    }
]

)

prompt = response.choices[0].message.content.strip()
print("🎯 Prompt:", prompt)

# Step 2: Generate image from prompt
image_gen = openai.images.generate(
    model="dall-e-3",
    prompt=prompt,
    size="1024x1024",
    n=1
)

image_url = image_gen.data[0].url
print("🖼️ Image URL:", image_url)

# Step 3: Download the image
response = requests.get(image_url)
filename = f"generated_background_{datetime.now().strftime('%Y%m%d%H%M%S')}.png"
with open(filename, "wb") as f:
    f.write(response.content)

print(f"✅ Image saved as {filename}")
