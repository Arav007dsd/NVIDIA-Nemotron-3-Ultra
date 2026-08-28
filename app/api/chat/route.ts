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

function isContinuation(messages: ChatMessage[]) {
  const last = messages[messages.length - 1]?.content?.toLowerCase() || "";
  return last.startsWith("continue exactly where") || last.includes("continue any file blocks");
}

async function callNvidia(apiKey: string, messages: ChatMessage[], thinking: boolean, maxTokens: number) {
  return fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 1,
      top_p: 0.95,
      stream: true,
      chat_template_kwargs: {
        enable_thinking: thinking,
        force_nonempty_content: true,
        ...(thinking ? { medium_effort: true } : {}),
      },
    }),
    cache: "no-store",
  });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "NVIDIA_API_KEY is missing in Vercel Environment Variables." }, { status: 500 });
    }

    const body = await req.json();
    const incoming = cleanMessages(body?.messages);
    const continuation = body?.continuation === true || isContinuation(incoming);
    const thinkingRequested = body?.thinking === true;
    const thinking = continuation ? false : thinkingRequested;
    const projectContext = typeof body?.projectContext === "string" ? body.projectContext.slice(0, 120000) : "";

    if (!incoming.length || incoming[incoming.length - 1].role !== "user") {
      return Response.json({ error: "The last conversation message must be from the user." }, { status: 400 });
    }

    // Continuation calls do not need the full uploaded ZIP/context again. This keeps
    // subsequent requests small and avoids wasting the 60s Hobby execution window.
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
- If the project is too large for one response, continue across requests without repeating previous files.
- For continuation requests, output ONLY the missing continuation. Do not repeat previous files or explanations.
- If a FILE block was cut off, finish that exact file before starting a new FILE block.
${!continuation && projectContext ? `\nUPLOADED PROJECT CONTEXT:\n${projectContext}` : ""}`;

    const requestMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...incoming,
    ];

    // Keep individual calls small enough for Vercel Hobby's current execution window.
    // Continuations are deliberately non-thinking so they return useful content quickly.
    const maxTokens = thinking ? 3200 : 5000;
    let upstream = await callNvidia(apiKey, requestMessages, thinking, maxTokens);

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("NVIDIA API", upstream.status, detail);
      return Response.json(
        { error: `NVIDIA API returned HTTP ${upstream.status}.`, detail: detail.slice(0, 6000) },
        { status: 502 },
      );
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
        let reasoningSeen = false;
        let retriedNoContent = false;

        const send = (payload: unknown) => controller.enqueue(encoder.encode(sse(payload)));

        const processData = (raw: string) => {
          if (!raw || raw === "[DONE]") return;
          const parsed = JSON.parse(raw);
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta;
          const content = typeof delta?.content === "string" ? delta.content : "";
          if (content) {
            sentContent = true;
            send({ type: "content", content });
          }
          if (delta?.reasoning_content || delta?.reasoning) {
            reasoningSeen = true;
            send({ type: "status", content: "Thinking…" });
          }
          if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        };

        const consume = async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try { processData(data); } catch (e) { console.error("SSE parse error", e); }
            }
          }
          buffer += decoder.decode();
          for (const rawLine of buffer.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try { processData(data); } catch (e) { console.error("Final SSE parse error", e); }
          }
        };

        try {
          await consume();

          // A continuation occasionally returns reasoning metadata but no visible
          // content. Retry once as a short, non-thinking completion. The retry is
          // only used when the first upstream call produced zero visible content.
          if (!sentContent && (continuation || reasoningSeen)) {
            retriedNoContent = true;
            try { reader.releaseLock(); } catch {}
            upstream = await callNvidia(apiKey, requestMessages, false, 3500);
            if (upstream.ok && upstream.body) {
              const retryReader = upstream.body.getReader();
              buffer = "";
              const retryDecoder = new TextDecoder();
              while (true) {
                const { value, done } = await retryReader.read();
                if (done) break;
                buffer += retryDecoder.decode(value, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || "";
                for (const rawLine of lines) {
                  const line = rawLine.trim();
                  if (!line.startsWith("data:")) continue;
                  const data = line.slice(5).trim();
                  if (!data || data === "[DONE]") continue;
                  try { processData(data); } catch (e) { console.error("Retry SSE parse error", e); }
                }
              }
              buffer += retryDecoder.decode();
              for (const rawLine of buffer.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try { processData(data); } catch (e) { console.error("Retry final SSE parse error", e); }
              }
              retryReader.releaseLock();
            }
          }

          if (!sentContent) {
            send({ type: "error", error: retriedNoContent
              ? "NVIDIA returned no visible answer after an automatic retry. Turn Thinking Mode off and retry this message."
              : "NVIDIA returned no visible answer." });
          } else if (finishReason === "length") {
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
          try { reader.releaseLock(); } catch {}
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
