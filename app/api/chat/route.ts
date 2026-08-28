export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    .filter(item => item.role === "user" || item.role === "assistant")
    .map(item => ({ role: item.role as "user" | "assistant", content: item.content }));
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "NVIDIA_API_KEY is missing in Vercel Environment Variables." }, { status: 500 });
    }

    const body = await req.json();
    const incoming = cleanMessages(body?.messages);
    const thinking = body?.thinking === true;
    const projectContext = typeof body?.projectContext === "string" ? body.projectContext.slice(0, 120000) : "";

    if (!incoming.length || incoming[incoming.length - 1].role !== "user") {
      return Response.json({ error: "The last conversation message must be from the user." }, { status: 400 });
    }

    const systemPrompt = `You are Nemotron Code AI, a professional full-stack coding agent.

You must give a COMPLETE answer. Never intentionally stop after a plan, outline, partial snippet, or explanation when the user asks you to build something. If the task is large, prioritize producing the actual runnable implementation and all required files.

You can work with Python, JavaScript, TypeScript, React, Next.js, Node.js, HTML, CSS, PHP, SQL, APIs and common programming tools.

When the user asks to create or modify a website/application/project:
1. Build the complete implementation, not a tutorial.
2. Include every required file for the requested feature.
3. Include package.json and required configuration files when applicable.
4. Include complete imports, exports, types, routes, components and styles.
5. Do not leave TODO, FIXME, placeholder implementations, fake buttons or unfinished functions.
6. Make the result runnable with the appropriate install/dev/build commands.
7. Keep secrets and API keys out of generated source code.
8. Use relative paths only.

MANDATORY PROJECT FILE FORMAT:
For every file you create or modify, output it exactly like this:

FILE: relative/path/to/file.ext
```language
COMPLETE FILE CONTENT
```

Example:
FILE: app/page.tsx
```tsx
export default function Home() { return <main>Hello</main>; }
```

Rules for FILE blocks:
- One FILE header per file.
- The path must be relative and must include the real folder structure.
- The fenced block must contain the COMPLETE file, not a fragment.
- Never put two files in one code block.
- Never omit a required file.
- Keep explanations outside FILE blocks.
- If modifying an existing project, preserve the existing structure unless there is a good technical reason to change it.

For normal questions, answer normally. For coding/project requests, return the actual implementation first and a concise explanation after it.

${projectContext ? `PROJECT FILE CONTEXT FROM USER UPLOAD:\n${projectContext}\n\nUse this context accurately. Do not claim to visually inspect images or binary files unless their actual contents are provided to the model.` : ""}`;

    const requestMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...incoming,
    ];

    // NVIDIA documents max_tokens up to 32768 for Nemotron 3 Ultra.
    // 24K leaves enough room for large complete projects while avoiding an unnecessarily huge default.
    const requestBody = {
      model: MODEL,
      messages: requestMessages,
      max_tokens: thinking ? 24000 : 24000,
      temperature: 1,
      top_p: 0.95,
      stream: true,
      chat_template_kwargs: thinking
        ? { enable_thinking: true, medium_effort: true, force_nonempty_content: true }
        : { enable_thinking: false, force_nonempty_content: true },
    };

    const upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("NVIDIA API", upstream.status, detail);
      return Response.json(
        {
          error: `NVIDIA API returned HTTP ${upstream.status}.`,
          detail: detail.slice(0, 6000),
        },
        { status: 502 },
      );
    }

    if (!upstream.body) {
      return Response.json({ error: "NVIDIA returned an empty response stream." }, { status: 502 });
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let buffer = "";
        let sentContent = false;
        let finishReason: string | null = null;
        let sawDone = false;

        const sendContent = (content: string) => {
          if (!content) return;
          sentContent = true;
          controller.enqueue(encoder.encode(sse({ type: "content", content })));
        };

        const processData = (rawData: string) => {
          if (!rawData || rawData === "[DONE]") {
            sawDone = true;
            return;
          }
          const parsed = JSON.parse(rawData);
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta;
          const content = typeof delta?.content === "string" ? delta.content : "";

          if (content) sendContent(content);
          if (delta?.reasoning_content || delta?.reasoning) {
            controller.enqueue(encoder.encode(sse({ type: "status", content: "Thinking…" })));
          }
          if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
        };

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;
              const rawData = line.slice(5).trim();
              if (!rawData) continue;
              try {
                processData(rawData);
              } catch (error) {
                console.error("NVIDIA SSE parse error", error, rawData.slice(0, 500));
              }
            }
          }

          buffer += decoder.decode();
          const remainingLines = buffer.split(/\r?\n/);
          for (const rawLine of remainingLines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const rawData = line.slice(5).trim();
            if (!rawData) continue;
            try {
              processData(rawData);
            } catch (error) {
              console.error("NVIDIA final SSE parse error", error);
            }
          }

          if (!sentContent) {
            controller.enqueue(
              encoder.encode(
                sse({
                  type: "error",
                  error: "NVIDIA completed the request but returned no final text. Retry with Thinking Mode off if this repeats.",
                }),
              ),
            );
          }

          controller.enqueue(
            encoder.encode(
              sse({
                type: "done",
                hasContent: sentContent,
                finishReason,
                upstreamDone: sawDone,
              }),
            ),
          );
          controller.close();
        } catch (error) {
          console.error("NVIDIA stream error", error);
          controller.enqueue(
            encoder.encode(
              sse({
                type: "error",
                error: error instanceof Error ? error.message : "NVIDIA streaming failed.",
              }),
            ),
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
      { error: error instanceof Error ? error.message : "Unexpected server error." },
      { status: 500 },
    );
  }
}
