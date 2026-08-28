export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function cleanMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { role: string; content: string } => {
      if (!item || typeof item !== "object") return false;
      const x = item as { role?: unknown; content?: unknown };
      return typeof x.role === "string" && typeof x.content === "string";
    })
    .filter(x => x.role === "user" || x.role === "assistant")
    .map(x => ({ role: x.role as "user" | "assistant", content: x.content }));
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) return Response.json({ error: "NVIDIA_API_KEY is missing in Vercel Environment Variables." }, { status: 500 });

    const body = await req.json();
    const incoming = cleanMessages(body?.messages);
    const thinking = body?.thinking === true;
    const projectContext = typeof body?.projectContext === "string" ? body.projectContext.slice(0, 120000) : "";
    if (!incoming.length || incoming[incoming.length - 1].role !== "user") {
      return Response.json({ error: "The last conversation message must be from the user." }, { status: 400 });
    }

    const systemPrompt = `You are Nemotron Code AI, a professional full-stack coding agent.
Give COMPLETE, useful answers. When the user asks to build a website, application, or project, generate the actual runnable implementation, not just an explanation.
For coding/project tasks:
- Generate real implementation code.
- Use this exact format for every generated file: FILE: relative/path/to/file.ext followed by one fenced code block containing the COMPLETE file.
- Use relative paths only.
- Include package.json and required configuration when applicable.
- Include complete imports, exports, routes, components, types and styles.
- Never leave TODO, FIXME, fake buttons, missing functions, or unfinished implementations.
- Keep secrets out of source code and use environment variables.
- If the project is too large for one response, continue naturally across requests without repeating previous files.
- For continuation requests, start exactly after the supplied previous assistant text and do not repeat it.
For normal questions, answer normally.
${projectContext ? `\nUPLOADED PROJECT CONTEXT:\n${projectContext}` : ""}`;

    // Keep each individual request comfortably below the Hobby 60-second limit.
    // The browser automatically asks for continuation when the model reaches this limit.
    const maxTokens = thinking ? 4000 : 6000;
    const upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...incoming],
        max_tokens: maxTokens,
        temperature: 1,
        top_p: 0.95,
        stream: true,
        chat_template_kwargs: thinking
          ? { enable_thinking: true, medium_effort: true, force_nonempty_content: true }
          : { enable_thinking: false, force_nonempty_content: true },
      }),
      cache: "no-store",
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("NVIDIA API", upstream.status, detail);
      return Response.json({ error: `NVIDIA API returned HTTP ${upstream.status}.`, detail: detail.slice(0, 6000) }, { status: 502 });
    }
    if (!upstream.body) return Response.json({ error: "NVIDIA returned an empty response stream." }, { status: 502 });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buffer = "";
        let sentContent = false;
        let finishReason: string | null = null;
        const send = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));

        const process = (raw: string) => {
          if (!raw || raw === "[DONE]") return;
          const parsed = JSON.parse(raw);
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === "string" && delta.content) {
            sentContent = true;
            send({ type: "content", content: delta.content });
          }
          if (delta?.reasoning_content || delta?.reasoning) send({ type: "status", content: "Thinking…" });
          if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        };

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
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try { process(data); } catch (e) { console.error("SSE parse error", e); }
            }
          }
          buffer += decoder.decode();
          for (const raw of buffer.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try { process(data); } catch (e) { console.error("Final SSE parse error", e); }
          }

          if (!sentContent) {
            send({ type: "error", error: "NVIDIA completed the request but returned no final text. Try Thinking Mode off." });
          } else if (finishReason === "length") {
            // Deliberately do not send type=done. The existing client treats this as a
            // resumable response and immediately asks NVIDIA to continue.
            send({ type: "continue", reason: "length" });
          } else {
            send({ type: "done", hasContent: true, finishReason });
          }
          controller.close();
        } catch (error) {
          console.error("NVIDIA stream error", error);
          if (sentContent) send({ type: "continue", reason: "stream-interrupted" });
          else send({ type: "error", error: error instanceof Error ? error.message : "NVIDIA streaming failed." });
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
