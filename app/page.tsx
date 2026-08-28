"use client";

import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = { role: "user" | "assistant"; content: string };
type ProjectFile = { path: string; content: string };
type ImageAttachment = { id: string; name: string; url: string; size: number };
type SavedChat = { id: string; title: string; messages: Message[]; updatedAt: number };

const HISTORY_KEY = "nemotron-code-chat-history-v1";
const MAX_HISTORY = 30;
const MAX_PROJECT_CHARS = 120_000;
const MAX_FILE_CHARS = 24_000;
const MAX_FILES = 60;
const IGNORED_PARTS = ["node_modules/", ".next/", ".git/", "dist/", "build/", "coverage/"];
const TEXT_EXTENSIONS = new Set(["ts","tsx","js","jsx","json","css","scss","sass","html","md","mdx","txt","py","pyx","java","kt","go","rs","php","rb","c","cpp","h","hpp","cs","sql","sh","bash","yml","yaml","toml","ini","env","mjs","cjs","astro","vue","svelte","xml","svg"]);

function isTextFile(name: string) {
  if (name.endsWith("/")) return false;
  const clean = name.split("?")[0].toLowerCase();
  const ext = clean.includes(".") ? clean.split(".").pop() || "" : "";
  return TEXT_EXTENSIONS.has(ext);
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function chatTitle(messages: Message[]) {
  const first = messages.find(m => m.role === "user")?.content?.trim() || "New chat";
  return first.length > 34 ? `${first.slice(0, 34)}…` : first;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectName, setProjectName] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<SavedChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const historyReady = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const saved = raw ? JSON.parse(raw) : [];
      if (Array.isArray(saved)) setHistory(saved.slice(0, MAX_HISTORY));
    } catch (error) { console.error("Could not load chat history", error); }
    historyReady.current = true;
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);
  useEffect(() => () => images.forEach(image => URL.revokeObjectURL(image.url)), [images]);

  function writeHistory(next: SavedChat[]) {
    const trimmed = next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY);
    setHistory(trimmed);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed)); } catch (error) { console.error("Could not save chat history", error); }
  }

  function saveChat(nextMessages: Message[], chatId = activeChatId) {
    if (!historyReady.current || !nextMessages.some(m => m.content.trim())) return;
    const id = chatId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    const item: SavedChat = { id, title: chatTitle(nextMessages), messages: nextMessages, updatedAt: Date.now() };
    writeHistory([item, ...history.filter(chat => chat.id !== id)]);
    setActiveChatId(id);
  }

  function newChat() {
    if (loading) abortRef.current?.abort();
    setMessages([]); setInput(""); setNotice(""); setStatusText(""); setActiveChatId(null);
  }

  function openChat(chat: SavedChat) {
    if (loading) return;
    setActiveChatId(chat.id); setMessages(chat.messages); setInput(""); setNotice(""); setStatusText("");
  }

  function deleteChat(id: string) {
    const next = history.filter(chat => chat.id !== id);
    writeHistory(next);
    if (activeChatId === id) {
      setActiveChatId(null); setMessages([]); setInput("");
    }
  }

  function clearProject() { setProjectFiles([]); setProjectName(""); setNotice("Project context cleared."); }
  function removeImage(id: string) {
    setImages(current => {
      const found = current.find(item => item.id === id);
      if (found) URL.revokeObjectURL(found.url);
      return current.filter(item => item.id !== id);
    });
  }

  async function handleZip(file: File) {
    setNotice("Reading ZIP project...");
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(entry => !entry.dir && !IGNORED_PARTS.some(part => entry.name.includes(part)) && isTextFile(entry.name));
      const selected = entries.slice(0, MAX_FILES);
      let total = 0;
      const files: ProjectFile[] = [];
      for (const entry of selected) {
        if (total >= MAX_PROJECT_CHARS) break;
        const raw = await entry.async("string");
        const remaining = MAX_PROJECT_CHARS - total;
        const content = raw.slice(0, Math.min(MAX_FILE_CHARS, remaining));
        total += content.length;
        files.push({ path: entry.name, content });
      }
      setProjectFiles(files); setProjectName(file.name);
      setNotice(`Loaded ${files.length} text files from ${file.name}. ${formatBytes(total)} of code/context is ready.`);
      setInput("Explain this uploaded project: architecture, important files, how it works, and what I should change next.");
    } catch (error) { console.error(error); setNotice("Could not read this ZIP file."); }
  }

  function handleImages(fileList: FileList | null) {
    if (!fileList?.length) return;
    const incoming = Array.from(fileList).slice(0, 8).map(file => ({ id: `${file.name}-${file.lastModified}-${Math.random()}`, name: file.name, url: URL.createObjectURL(file), size: file.size }));
    setImages(current => [...current, ...incoming].slice(-8));
    setNotice("Images attached as project references. Nemotron 3 Ultra is a text model, so the files are not visually analyzed.");
  }

  function buildProjectContext() {
    if (!projectFiles.length && !images.length) return "";
    const files = projectFiles.map(file => `\n===== FILE: ${file.path} =====\n${file.content}`).join("\n");
    const imageList = images.length ? `\n\n===== IMAGE REFERENCES =====\n${images.map(image => `- ${image.name} (${formatBytes(image.size)})`).join("\n")}` : "";
    return `The user uploaded project context. Use it when answering. Do not claim to have visually analyzed images; image files are reference metadata only.\nProject ZIP: ${projectName || "none"}\n${files}${imageList}`;
  }

  async function sendMessage(customPrompt?: string) {
    const text = (customPrompt ?? input).trim();
    if (!text || loading) return;
    const updated = [...messages, { role: "user" as const, content: text }];
    const assistantPlaceholder = { role: "assistant" as const, content: "" };
    const requestMessages = updated;
    const chatId = activeChatId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    setActiveChatId(chatId);
    setMessages([...updated, assistantPlaceholder]);
    saveChat(updated, chatId);
    setInput(""); setLoading(true); setStatusText("Connecting to NVIDIA…"); setNotice("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ messages: requestMessages, thinking, projectContext: buildProjectContext() }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail ? `${data.error || "NVIDIA request failed"} ${data.detail}` : (data.error || `Request failed with HTTP ${response.status}`));
      }
      if (!response.body) throw new Error("NVIDIA returned no response stream.");

      setStatusText(thinking ? "Thinking and generating…" : "Generating…");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      const applyText = (content: string) => {
        assistantText += content;
        setMessages(current => {
          const copy = [...current];
          const last = copy.length - 1;
          copy[last] = { role: "assistant", content: assistantText };
          return copy;
        });
      };

      const processEvent = (part: string) => {
        const line = part.split(/\r?\n/).find(item => item.startsWith("data:"));
        if (!line) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") return;
        const data = JSON.parse(raw);
        if (data.type === "content") applyText(String(data.content || ""));
        if (data.type === "status") setStatusText(String(data.content || "Generating…"));
        if (data.type === "error") throw new Error(String(data.error || "Generation failed."));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        for (const part of parts) {
          try { processEvent(part); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        }
      }
      if (buffer.trim()) {
        try { processEvent(buffer); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      if (!assistantText) throw new Error("NVIDIA connected but returned no answer. Try Thinking Mode off once, then retry.");
      saveChat([...updated, { role: "assistant", content: assistantText }], chatId);
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError" ? "Generation stopped." : error instanceof Error ? error.message : "Unknown error";
      const finalMessages = [...updated, { role: "assistant" as const, content: `❌ **Error:** ${message}` }];
      setMessages(finalMessages); saveChat(finalMessages, chatId);
    } finally {
      abortRef.current = null; setLoading(false); setStatusText("");
    }
  }

  async function copyCode(text: string) { await navigator.clipboard.writeText(text); }
  const suggestions = [["🐍 Build Python App", "Create a complete Python task manager application."], ["⚛️ React Component", "Create a modern React dashboard component using Tailwind CSS."], ["🐛 Fix My Error", "Help me debug this code. Explain the error and provide the fixed version."], ["🌐 Build Website", "Create a modern responsive landing page using HTML, CSS and JavaScript."]];

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="logo"><div className="logo-icon">⚡</div><div><h1>Nemotron Code</h1><span>AI Coding Assistant</span></div></div>
        <button className="new-chat" onClick={newChat}>＋ New Chat</button>

        <div className="history-section">
          <div className="history-title"><span>CHAT HISTORY</span>{history.length > 0 && <button onClick={() => writeHistory([])}>Clear</button>}</div>
          <div className="history-list">
            {history.length === 0 ? <div className="history-empty">Your chats will appear here.</div> : history.map(chat => (
              <div className={`history-item ${activeChatId === chat.id ? "active" : ""}`} key={chat.id}>
                <button className="history-open" onClick={() => openChat(chat)} title={chat.title}>💬 <span>{chat.title}</span></button>
                <button className="history-delete" onClick={() => deleteChat(chat.id)} aria-label="Delete chat">×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-section"><p>QUICK ACTIONS</p><button onClick={() => sendMessage("Write clean production-ready code for my project.")}>✨ Generate Code</button><button onClick={() => sendMessage("I have a bug. Help me debug and explain the issue.")}>🐛 Fix Error</button><button onClick={() => sendMessage("Explain this code in simple language.")}>📖 Explain Code</button><button onClick={() => sendMessage("Optimize and improve this code.")}>🚀 Optimize</button></div>
        <div className="upload-card"><strong>📦 Project Uploads</strong><p>Upload a ZIP of your website/code or attach image references.</p><div className="upload-buttons"><button className="upload-button" onClick={() => zipInputRef.current?.click()}>Upload ZIP</button><button className="upload-button" onClick={() => imageInputRef.current?.click()}>Upload Images</button></div><input ref={zipInputRef} type="file" accept=".zip,application/zip" hidden onChange={e => e.target.files?.[0] && handleZip(e.target.files[0])}/><input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={e => handleImages(e.target.files)}/>{(projectFiles.length > 0 || images.length > 0) && <div className="upload-list">{projectFiles.length > 0 && <span className="upload-pill">📦 {projectName || "project.zip"} · {projectFiles.length} files <button onClick={clearProject}>×</button></span>}{images.map(image => <span className="upload-pill" key={image.id}>🖼️ {image.name} <button onClick={() => removeImage(image.id)}>×</button></span>)}</div>}<div className="upload-note">ZIP parser skips node_modules, .next, .git, build and generated folders.</div></div>
        <div className="sidebar-bottom"><div className="model-card"><span className="status"/><div><strong>Nemotron 3 Ultra</strong><small>550B total · 55B active</small></div></div><label className="thinking-toggle"><span>🧠 Thinking Mode</span><input type="checkbox" checked={thinking} onChange={e => setThinking(e.target.checked)}/></label></div>
      </aside>

      <section className="chat-area"><header className="header"><div><h2>AI Coding Assistant</h2><p>Powered by NVIDIA Nemotron 3 Ultra</p></div><div className="header-status"><span/>Online</div></header>
        <div className="messages">{messages.length === 0 && <div className="welcome"><div className="welcome-icon">⚡</div><h2>What do you want to build?</h2><p>Ask me to write code, fix bugs, explain errors, or upload a ZIP so I can reason over the project files.</p><div className="suggestions">{suggestions.map(([title,prompt]) => <button key={title} onClick={() => sendMessage(prompt)}><strong>{title}</strong></button>)}</div></div>}{messages.map((message,index) => <div key={index} className={`message ${message.role}`}><div className="avatar">{message.role === "user" ? "U" : "⚡"}</div><div className="message-content">{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{code({children,className,...props}){const text=String(children).replace(/\n$/,""); const block=Boolean(className?.includes("language-")); if(block)return <div className="code-wrapper"><button className="copy-button" onClick={() => copyCode(text)}>Copy</button><pre><code className={className} {...props}>{text}</code></pre></div>; return <code {...props}>{children}</code>;}}}>{message.content || statusText || "Generating…"}</ReactMarkdown> : <p>{message.content}</p>}</div></div>)}<div ref={bottomRef}/></div>
        <div className="input-container">{images.length > 0 && <div className="attachment-preview">{images.map(image => <div className="image-thumb" key={image.id} title={image.name}><img src={image.url} alt={image.name}/><button onClick={() => removeImage(image.id)}>×</button></div>)}</div>}<div className="input-box"><textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => {if(e.key === "Enter" && !e.shiftKey){e.preventDefault();sendMessage();}}} placeholder={projectFiles.length ? "Ask about the uploaded project..." : "Ask anything about programming..."} rows={1} disabled={loading}/><button className="send-button" onClick={() => loading ? abortRef.current?.abort() : sendMessage()} disabled={!loading && !input.trim()}>{loading ? "■" : "➤"}</button></div><p className="hint">{statusText || notice || "Enter to send · Shift + Enter for new line · Chats are saved in this browser"}</p></div>
      </section>
    </main>
  );
}
