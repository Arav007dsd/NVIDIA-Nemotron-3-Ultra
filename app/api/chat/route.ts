export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

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

function normalizeApiKey(value: string) {
  let key = value.trim();
  key = key.replace(/^Bearer\s+/i, "").trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

function isContinuation(messages: ChatMessage[]) {
  const last = messages[messages.length - 1]?.content?.toLowerCase() || "";
  return last.startsWith("continue exactly where") || last.includes("continue any file blocks");
}

function authHeaders(apiKey: string, accept = "application/json") {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: accept,
  };
}

async function callNvidia(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  thinking: boolean,
  maxTokens: number,
) {
  return fetch(NVIDIA_URL, {
    method: "POST",
    headers: authHeaders(apiKey, "text/event-stream, application/json"),
    body: JSON.stringify({
      model,
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

async function diagnose404(apiKey: string) {
  try {
    const response = await fetch(MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) {
      return { kind: "auth" as const, status: response.status, detail: text.slice(0, 1500) };
    }
    let data: any = {};
    try { data = JSON.parse(text); } catch {}
    const ids = Array.isArray(data?.data)
      ? data.data.map((x: any) => x?.id).filter((x: any): x is string => typeof x === "string")
      : [];
    return {
      kind: ids.includes(MODEL) ? "model-present" as const : "model-missing" as const,
      status: response.status,
      ids: ids.filter((id: string) => id.toLowerCase().includes("nemotron")).slice(0, 20),
    };
  } catch (error) {
    return {
      kind: "network" as const,
      status: 0,
      detail: error instanceof Error ? error.message : "Unable to reach NVIDIA.",
    };
  }
}

async function nvidiaErrorResponse(apiKey: string, status: number, detail: string) {
  if (status === 404) {
    const diagnosis = await diagnose404(apiKey);

    if (diagnosis.kind === "auth") {
      return Response.json(
        {
          error: "NVIDIA API authentication/permission failed.",
          detail:
            `NVIDIA returned HTTP 404 and the API key could not access /v1/models (HTTP ${diagnosis.status}). ` +
            "Create a fresh NVIDIA key with Public API Endpoints permission and replace NVIDIA_API_KEY in Vercel.",
        },
        { status: 502 },
      );
    }

    if (diagnosis.kind === "model-missing") {
      return Response.json(
        {
          error: "Nemotron 3 Ultra is not available to this NVIDIA API key.",
          detail:
            `The key can reach NVIDIA, but "${MODEL}" is not present in its /v1/models catalog. ` +
            "Refresh/regenerate the NVIDIA key at build.nvidia.com and make sure Public API Endpoints access is enabled.",
          availableNemotronModels: diagnosis.ids,
        },
        { status: 502 },
      );
    }

    if (diagnosis.kind === "network") {
      return Response.json(
        { error: "NVIDIA returned HTTP 404 and the model-catalog check could not run.", detail: diagnosis.detail },
        { status: 502 },
      );
    }

    return null;
  }

  if (status === 401 || status === 403) {
    return Response.json(
      {
        error: `NVIDIA API authorization failed (HTTP ${status}).`,
        detail:
          "Check that NVIDIA_API_KEY is a current nvapi key with Public API Endpoints permission. " +
          "Do not include the word 'Bearer', quotes, or a curl command in the Vercel variable.",
      },
      { status: 502 },
    );
  }

  return Response.json(
    { error: `NVIDIA API returned HTTP ${status}.`, detail: detail.slice(0, 6000) },
    { status: 502 },
  );
}

export async function POST(req: Request) {
  try {
    const rawKey = process.env.NVIDIA_API_KEY || "";
    const apiKey = normalizeApiKey(rawKey);

    if (!apiKey) {
      return Response.json(
        { error: "NVIDIA_API_KEY is missing in Vercel Environment Variables." },
        { status: 500 },
      );
    }

    const body = await req.json();
    const incoming = cleanMessages(body?.messages);
    const continuation = body?.continuation === true || isContinuation(incoming);
    const thinkingRequested = body?.thinking === true;
    const thinking = continuation ? false : thinkingRequested;
    const projectContext = typeof body?.projectContext === "string" ? body.projectContext.slice(0, 120000) : "";

    if (!incoming.length || incoming[incoming.length - 1].role !== "user") {
      return Response.json(
        { error: "The last conversation message must be from the user." },
        { status: 400 },
      );
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
- If the project is too large for one response, continue across requests without repeating previous files.
- For continuation requests, output ONLY the missing continuation. Do not repeat previous files or explanations.
- If a FILE block was cut off, finish that exact file before starting a new FILE block.
${!continuation && projectContext ? `\nUPLOADED PROJECT CONTEXT:\n${projectContext}` : ""}`;

    const requestMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...incoming,
    ];

    const maxTokens = thinking ? 3200 : 5000;
    let upstream = await callNvidia(apiKey, MODEL, requestMessages, thinking, maxTokens);

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("NVIDIA API", upstream.status, detail);

      const handled = await nvidiaErrorResponse(apiKey, upstream.status, detail);
      if (handled) return handled;

      await new Promise(resolve => setTimeout(resolve, 1200));
      upstream = await callNvidia(apiKey, MODEL, requestMessages, thinking, maxTokens);
      if (!upstream.ok) {
        const retryDetail = await upstream.text();
        console.error("NVIDIA API retry", upstream.status, retryDetail);
        return Response.json(
          { error: `NVIDIA API returned HTTP ${upstream.status} after retry.`, detail: retryDetail.slice(0, 6000) },
          { status: 502 },
        );
      }
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

        const consume = async (streamReader: ReadableStreamDefaultReader<Uint8Array>) => {
          while (true) {
            const { value, done } = await streamReader.read();
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
          await consume(reader);

          if (!sentContent && (continuation || reasoningSeen)) {
            retriedNoContent = true;
            try { reader.releaseLock(); } catch {}
            const retry = await callNvidia(apiKey, MODEL, requestMessages, false, 3500);
            if (retry.ok && retry.body) {
              const retryReader = retry.body.getReader();
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
            send({
              type: "error",
              error: retriedNoContent
                ? "NVIDIA returned no visible answer after an automatic retry. Turn Thinking Mode off and retry this message."
                : "NVIDIA returned no visible answer.",
            });
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
    return Response.json(
      { error: error instanceof Error ? error.message : "Unexpected server error." },
      { status: 500 },
    );
  }
}
