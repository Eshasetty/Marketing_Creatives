# run_layoutgpt_2d.py
import json
import torch
from transformers import GPT2TokenizerFast

# Mapping LLM name to model id
llm_name2id = {
    'gpt4': 'gpt-4',
    'gpt3.5': 'gpt-3.5-turbo',
    'gpt4o': 'gpt-4o',
}

def form_prompt_for_chatgpt(user_prompt, canvas_size=256):
    system_prompt = (
        f"Instruction: Given a sentence prompt that will be used to generate an image, "
        f"plan the layout of the image. The generated layout should follow CSS style, "
        f"where each line starts with the object description and is followed by its absolute position. "
        f'Formally: "object {{width: ?px; height: ?px; left: ?px; top: ?px; }}". '
        f"The image is {canvas_size}px wide and {canvas_size}px high. "
        f"All positions must not exceed {canvas_size}px.\n"
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Prompt: {user_prompt}\nLayout:"}
    ]
    return messages

def gpt_generation(messages, f_gpt_create, llm_id="gpt-4", n_iter=1):
    response = f_gpt_create(
        model=llm_id,
        messages=messages,
        temperature=0.7,
        n=n_iter
    )
    response_text = [choice.message.content for choice in response.choices]
    return response_text, response
