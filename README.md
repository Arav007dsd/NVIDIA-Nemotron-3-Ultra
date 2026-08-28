# Nemotron Code AI

A Next.js coding assistant powered by **NVIDIA Nemotron 3 Ultra 550B A55B**.

## Features

- Streaming AI coding chat.
- Thinking Mode toggle.
- Upload a `.zip` website/project and load text source files into the conversation context.
- Attach image references and preview them in the UI.
- Server-side NVIDIA API key; it is never placed in browser code.
- Vercel-ready Next.js App Router.

## Run locally

1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.local.example` to `.env.local`.
4. Add your NVIDIA API key.
5. Run `npm run dev`.
6. Open `http://localhost:3000`.

## NVIDIA model

The app calls the OpenAI-compatible NVIDIA API with:

```env
NVIDIA_API_KEY=...
```

Model:

```text
nvidia/nemotron-3-ultra-550b-a55b
```

## ZIP/image upload behavior

ZIP files are parsed in the browser. Generated folders such as `node_modules`, `.next`, `.git`, `dist`, `build`, and `coverage` are skipped. The app loads up to 60 text files and caps the combined project context before sending it to the server.

Image files can be attached for visual reference in the UI. Nemotron 3 Ultra's current NVIDIA API listing is text-output, so this project does not claim to visually analyze those images. A multimodal model can be added later when needed.

## Vercel deployment

Import the repository into Vercel and set:

```text
NVIDIA_API_KEY
```

for the Production environment.

Do **not** commit `.env.local` or the real API key.
