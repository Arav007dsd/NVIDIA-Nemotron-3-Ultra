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
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const thinking = Boolean(body?.thinking);
    const projectContext =
      typeof body?.projectContext === "string"
        ? body.projectContext.slice(0, 140_000)
        : "";

    const systemPrompt = `You are Nemotron Code AI, an expert programming assistant. Help with writing, debugging, explaining, optimizing and converting code. Support Python, JavaScript, TypeScript, React, Next.js, Node.js, HTML/CSS, PHP, SQL and APIs. When project context is provided, ground your answer in the actual files and filenames. When the user asks to modify a project, give exact file paths and complete replacement snippets where useful. Never reveal private API keys, environment values, or hidden credentials.${
      projectContext
        ? `\n\nPROJECT CONTEXT:\n${projectContext}`
        : ""
    }`;

    const upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        temperature: 1,
        top_p: 0.95,
        max_tokens: 16384,
        reasoning_effort: thinking ? "high" : "none",
        reasoning_budget: thinking ? 8192 : 0,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("NVIDIA API error", upstream.status, detail);
      return Response.json(
        {
          error: `NVIDIA API returned HTTP ${upstream.status}.`,
          detail: detail.slice(0, 2000),
        },
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

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;

              try {
                const parsed = JSON.parse(data);
                const choice = parsed?.choices?.[0];
                const delta = choice?.delta;
                const content = delta?.content;
                const reasoning = delta?.reasoning_content;

                if (reasoning) {
                  controller.enqueue(encoder.encode(sse({ type: "reasoning", content: reasoning })));
                }
                if (content) {
                  controller.enqueue(encoder.encode(sse({ type: "content", content })));
                }
              } catch {
                // Ignore incomplete/non-JSON SSE lines; the upstream stream continues.
              }
            }
          }

          controller.enqueue(encoder.encode(sse({ type: "done" })));
          controller.close();
        } catch (error) {
          console.error("NVIDIA stream error", error);
          controller.enqueue(
            encoder.encode(
              sse({
                type: "error",
                error: error instanceof Error ? error.message : "Generation failed while streaming from NVIDIA.",
              })
            )
          );
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
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Something went wrong while contacting NVIDIA API.",
      },
      { status: 500 }
    );
  }
}
