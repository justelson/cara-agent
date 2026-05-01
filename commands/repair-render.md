# repair-render
description: debug Cara CLI spacing, streaming, and terminal rendering

Debug the Cara CLI terminal rendering path.

Rules:

- Preserve intentional user-message padding.
- Preserve intentional blank space above assistant messages.
- Do not edit prompts when the evidence points to streaming, wrapping, or renderer math.
- Check `src/cara-ui.mjs`, `src/terminal-input.mjs`, and `src/pi-markdown.mjs` before guessing.
- Verify with a narrow terminal-width simulation when possible.

Specific symptom:
{{args}}
