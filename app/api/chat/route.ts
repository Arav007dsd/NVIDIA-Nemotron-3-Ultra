export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) return Response.json({ error: "NVIDIA_API_KEY is missing in Vercel." }, { status: 500 });

    const body = await req.json();
    const incoming = Array.isArray(body?.messages) ? body.messages : [];
    const thinking = body?.thinking === true;
    const projectContext = typeof body?.projectContext === "string" ? body.projectContext.slice(0, 120000) : "";

    const messages = incoming.filter((m: unknown): m is { role: "user" | "assistant"; content: string } => {
      if (!m || typeof m !== "object") return false;
      const x = m as { role?: unknown; content?: unknown };
      return (x.role === "user" || x.role === "assistant") && typeof x.content === "string";
    });

    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return Response.json({ error: "The last conversation message must be from the user." }, { status: 400 });
    }

    const systemPrompt = `You are Nemotron Code AI, a professional coding assistant. Write, debug, explain, refactor and optimize software. Support Python, JavaScript, TypeScript, React, Next.js, Node.js, HTML, CSS, PHP, SQL, APIs and common programming tools. Be practical and concise. When project files are supplied, use their exact paths and contents. Never reveal API keys, secrets, environment values or hidden credentials.${projectContext ? `\n\nPROJECT FILE CONTEXT:\n${projectContext}` : ""}`;

    // NVIDIA's current API directly supports reasoning_effort: none|medium|high.
    // Using the documented top-level fields avoids the previous empty-content behavior.
    const requestBody = {
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: thinking ? 12000 : 8000,
      temperature: 1,
      top_p: 0.95,
      reasoning_effort: thinking ? "medium" : "none",
      ...(thinking ? { reasoning_budget: 4096 } : {}),
      stream: true,
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
      console.error("NVIDIA API", upstream.status, detail);
      return Response.json({ error: `NVIDIA API returned HTTP ${upstream.status}.`, detail: detail.slice(0, 4000) }, { status: 502 });
    }
    if (!upstream.body) return Response.json({ error: "NVIDIA returned an empty response stream." }, { status: 502 });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buffer = "";
        let sentContent = false;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const raw of lines) {
              const line = raw.trim();
              if (!line.startsWith("data:")) continue;
              const rawData = line.slice(5).trim();
              if (!rawData || rawData === "[DONE]") continue;
              try {
                const parsed = JSON.parse(rawData);
                const delta = parsed?.choices?.[0]?.delta;
                const content = typeof delta?.content === "string" ? delta.content : "";
                if (content) {
                  sentContent = true;
                  controller.enqueue(encoder.encode(sse({ type: "content", content })));
                }
                if (delta?.reasoning_content || delta?.reasoning) {
                  controller.enqueue(encoder.encode(sse({ type: "status", content: "Thinking…" })));
                }
              } catch {
                // Ignore malformed partial SSE frames.
              }
            }
          }
          if (buffer.trim().startsWith("data:")) {
            const rawData = buffer.trim().slice(5).trim();
            if (rawData && rawData !== "[DONE]") {
              try {
                const parsed = JSON.parse(rawData);
                const content = parsed?.choices?.[0]?.delta?.content;
                if (typeof content === "string" && content) {
                  sentContent = true;
                  controller.enqueue(encoder.encode(sse({ type: "content", content })));
                }
              } catch {}
            }
          }
          controller.enqueue(encoder.encode(sse({ type: "done", hasContent: sentContent })));
          controller.close();
        } catch (error) {
          console.error("NVIDIA stream error", error);
          controller.enqueue(encoder.encode(sse({ type: "error", error: error instanceof Error ? error.message : "NVIDIA streaming failed." })));
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
    return Response.json({ error: error instanceof Error ? error.message : "Unexpected server error." }, { status: 500 });
  }
}
