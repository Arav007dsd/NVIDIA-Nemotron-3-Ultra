export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "NVIDIA_API_KEY is missing. Add it in Vercel Environment Variables." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const incoming = Array.isArray(body?.messages) ? body.messages : [];
    const thinking = Boolean(body?.thinking);
    const projectContext = typeof body?.projectContext === "string"
      ? body.projectContext.slice(0, 140_000)
      : "";

    const messages = incoming.filter(
      (m: unknown): m is { role: "user" | "assistant"; content: string } =>
        !!m && typeof m === "object" &&
        (((m as { role?: unknown }).role === "user") || ((m as { role?: unknown }).role === "assistant")) &&
        typeof (m as { content?: unknown }).content === "string"
    );

    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return Response.json({ error: "The conversation must end with a user message." }, { status: 400 });
    }

    const systemPrompt = `You are Nemotron Code AI, an expert programming assistant. Help with writing, debugging, explaining, optimizing and converting code. Support Python, JavaScript, TypeScript, React, Next.js, Node.js, HTML/CSS, PHP, SQL and APIs. When project context is provided, ground your answer in the actual files and filenames. When asked to modify a project, give exact file paths and complete replacement snippets where useful. Never reveal private API keys, environment values, or hidden credentials.${
      projectContext ? `\n\nPROJECT CONTEXT:\n${projectContext}` : ""
    }`;

    // NVIDIA's current Nemotron API documents reasoning through the chat template.
    // This is intentionally sent as chat_template_kwargs instead of mixing older
    // client-side parameter conventions into the raw HTTP request.
    const chatTemplateKwargs: Record<string, unknown> = {
      enable_thinking: thinking,
      force_nonempty_content: true,
    };
    if (thinking) chatTemplateKwargs.reasoning_budget = 8192;

    const requestBody = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      max_tokens: 16000,
      temperature: 1,
      top_p: 0.95,
      stream: true,
      chat_template_kwargs: chatTemplateKwargs,
    };

    const upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(requestBody),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("NVIDIA API error", upstream.status, detail);
      return Response.json(
        { error: `NVIDIA API returned HTTP ${upstream.status}.`, detail: detail.slice(0, 4000) },
        { status: 502 }
      );
    }

    if (!upstream.body) {
      return Response.json({ error: "NVIDIA API returned an empty stream." }, { status: 502 });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              if (data === "[DONE]") {
                controller.enqueue(encoder.encode(sse({ type: "done" })));
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed?.choices?.[0]?.delta;
                const content = delta?.content;
                if (content) controller.enqueue(encoder.encode(sse({ type: "content", content })));
                // Do not expose hidden chain-of-thought to the browser.
                if (delta?.reasoning_content) controller.enqueue(encoder.encode(sse({ type: "status", content: "Generating response..." })));
              } catch {
                // Ignore malformed/incomplete SSE lines and keep reading.
              }
            }
          }

          if (buffer.trim().startsWith("data:")) {
            const data = buffer.trim().slice(5).trim();
            if (data && data !== "[DONE]") {
              try {
                const parsed = JSON.parse(data);
                const content = parsed?.choices?.[0]?.delta?.content;
                if (content) controller.enqueue(encoder.encode(sse({ type: "content", content })));
              } catch {}
            }
          }

          controller.enqueue(encoder.encode(sse({ type: "done" })));
          controller.close();
        } catch (error) {
          console.error("NVIDIA stream error", error);
          controller.enqueue(encoder.encode(sse({
            type: "error",
            error: error instanceof Error ? error.message : "Generation failed while streaming from NVIDIA.",
          })));
          controller.close();
        } finally {
          reader.releaseLock();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("Chat route error", error);
    return Response.json({
      error: error instanceof Error ? error.message : "Something went wrong while contacting NVIDIA API.",
    }, { status: 500 });
  }
}
