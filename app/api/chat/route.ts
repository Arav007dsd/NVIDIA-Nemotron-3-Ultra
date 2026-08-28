import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "NVIDIA_API_KEY is missing. Add it in Vercel Environment Variables." }, { status: 500 });
    }

    const body = await req.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const thinking = Boolean(body?.thinking);
    const projectContext = typeof body?.projectContext === "string" ? body.projectContext.slice(0, 140_000) : "";

    const client = new OpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey });
    const systemPrompt = `You are Nemotron Code AI, an expert programming assistant. Help with writing, debugging, explaining, optimizing and converting code. Support Python, JavaScript, TypeScript, React, Next.js, Node.js, HTML/CSS, PHP, SQL and APIs. When project context is provided, ground your answer in the actual files and filenames. When the user asks to modify a project, give exact file paths and complete replacement snippets where useful. Never reveal private API keys, environment values, or hidden credentials.`;

    const context = projectContext ? [{ role: "user" as const, content: `PROJECT CONTEXT:\n${projectContext}` }] : [];
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...context, ...messages],
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 16384,
      stream: true,
      extra_body: { chat_template_kwargs: { enable_thinking: thinking, force_nonempty_content: true } },
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content", content })}\n\n`));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
          controller.close();
        } catch (error) {
          console.error("NVIDIA stream error", error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Generation failed while streaming from NVIDIA." })}\n\n`));
          controller.close();
        }
      },
    });

    return new Response(readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Something went wrong while contacting NVIDIA API." }, { status: 500 });
  }
}
