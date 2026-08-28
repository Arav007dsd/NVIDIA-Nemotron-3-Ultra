"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = { role: "user" | "assistant"; content: string };
type ProjectFile = { path: string; content: string };
type Attachment = { id: string; name: string; url?: string; size: number; type: string; kind: "image" | "text" | "file" };
type SavedChat = { id: string; title: string; messages: Message[]; updatedAt: number };
type GeneratedFile = { path: string; content: string };

const HISTORY_KEY = "nemotron-code-chat-history-v3";
const MAX_HISTORY = 50;
const MAX_PROJECT_CHARS = 120000;
const MAX_FILE_CHARS = 24000;
const MAX_FILES = 100;
const MAX_CONTINUATIONS = 6;
const TEXT_EXTENSIONS = new Set(["ts","tsx","js","jsx","mjs","cjs","json","css","scss","sass","html","htm","md","mdx","txt","py","java","kt","go","rs","php","rb","c","cpp","h","hpp","cs","sql","sh","bash","zsh","yml","yaml","toml","ini","env","astro","vue","svelte","xml","svg","graphql","gql"]);
const IGNORED = ["node_modules/", ".next/", ".git/", "dist/", "build/", "coverage/"];

function ext(name: string) { const n = name.toLowerCase().split("?")[0]; return n.includes(".") ? n.split(".").pop() || "" : ""; }
function isTextFile(name: string) { return TEXT_EXTENSIONS.has(ext(name)) || name.toLowerCase().endsWith("/dockerfile"); }
function bytes(n: number) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
function titleFor(messages: Message[]) { const t = messages.find(m => m.role === "user")?.content.trim() || "New chat"; return t.length > 42 ? `${t.slice(0, 42)}…` : t; }
function safePath(path: string) { return path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(x => x && x !== "." && x !== "..").join("/") || "file.txt"; }
function extractGeneratedFiles(text: string): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  const re = /(?:^|\n)\s*(?:FILE|PATH)\s*:\s*([^\n`]+?)\s*\n\s*```[^\n]*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const path = safePath(match[1].trim().replace(/^['"]|['"]$/g, ""));
    const content = match[2].replace(/\n$/, "\n");
    if (path && content) out.push({ path, content });
  }
  return Array.from(new Map(out.map(f => [f.path, f])).values());
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<SavedChat[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectName, setProjectName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ready = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) { const data = JSON.parse(raw); if (Array.isArray(data)) setHistory(data.slice(0, MAX_HISTORY)); }
    } catch {}
    ready.current = true;
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);
  useEffect(() => () => files.forEach(f => f.url && URL.revokeObjectURL(f.url)), [files]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);

  function persist(items: SavedChat[]) {
    const next = [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY);
    setHistory(next); try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
  }
  function saveChat(items: Message[], id: string) {
    if (!ready.current || !items.length) return;
    persist([{ id, title: titleFor(items), messages: items, updatedAt: Date.now() }, ...history.filter(h => h.id !== id)]);
  }
  function newChat() { abortRef.current?.abort(); setMessages([]); setInput(""); setStatus(""); setNotice(""); setActiveChat(null); }
  function openChat(chat: SavedChat) { if (loading) return; setActiveChat(chat.id); setMessages(chat.messages); setNotice(""); }
  function removeChat(id: string) { persist(history.filter(h => h.id !== id)); if (activeChat === id) { setActiveChat(null); setMessages([]); } }
  function removeAttachment(id: string) { setFiles(cur => { const f = cur.find(x => x.id === id); if (f?.url) URL.revokeObjectURL(f.url); return cur.filter(x => x.id !== id); }); }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setNotice("Reading attachments…");
    const incoming: Attachment[] = [];
    let total = projectFiles.reduce((n, f) => n + f.content.length, 0);
    for (const file of Array.from(list).slice(0, 20)) {
      const id = `${file.name}-${file.lastModified}-${Math.random()}`;
      if (file.type.startsWith("image/")) incoming.push({ id, name: file.name, size: file.size, type: file.type, url: URL.createObjectURL(file), kind: "image" });
      else if (isTextFile(file.name) || file.type.startsWith("text/")) {
        try {
          const raw = await file.text();
          const content = raw.slice(0, Math.min(MAX_FILE_CHARS, Math.max(0, MAX_PROJECT_CHARS - total)));
          total += content.length;
          setProjectFiles(cur => [...cur, { path: file.name, content }].slice(-MAX_FILES));
          incoming.push({ id, name: file.name, size: file.size, type: file.type, kind: "text" });
        } catch { incoming.push({ id, name: file.name, size: file.size, type: file.type, kind: "file" }); }
      } else incoming.push({ id, name: file.name, size: file.size, type: file.type, kind: "file" });
    }
    setFiles(cur => [...cur, ...incoming].slice(-30)); setMenuOpen(false); setNotice(`${incoming.length} file${incoming.length === 1 ? "" : "s"} attached.`);
  }

  async function addZip(file: File) {
    setMenuOpen(false); setNotice("Reading ZIP project…");
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(e => !e.dir && !IGNORED.some(x => e.name.includes(x)) && isTextFile(e.name)).slice(0, MAX_FILES);
      let total = 0; const loaded: ProjectFile[] = [];
      for (const entry of entries) {
        if (total >= MAX_PROJECT_CHARS) break;
        const raw = await entry.async("string");
        const content = raw.slice(0, Math.min(MAX_FILE_CHARS, MAX_PROJECT_CHARS - total));
        total += content.length; loaded.push({ path: entry.name, content });
      }
      setProjectFiles(loaded); setProjectName(file.name);
      setFiles(cur => [...cur, { id: `zip-${Date.now()}`, name: file.name, size: file.size, type: "application/zip", kind: "file" }]);
      setNotice(`Loaded ${loaded.length} readable project files from ${file.name}.`);
    } catch { setNotice("Could not read this ZIP file."); }
  }

  function projectContext() {
    if (!projectFiles.length && !files.length) return "";
    const text = projectFiles.map(f => `\n===== FILE: ${f.path} =====\n${f.content}`).join("\n");
    const refs = files.filter(f => f.kind !== "text").map(f => `- ${f.name} (${bytes(f.size)}, ${f.type || "unknown"})`).join("\n");
    return `Uploaded project context. Use exact filenames when relevant. Only text/code contents are available. Do not claim to inspect binary files or images unless actual image input is supported.\nProject: ${projectName || "attachments"}\n${text}${refs ? `\n===== OTHER ATTACHMENTS =====\n${refs}` : ""}`.slice(0, MAX_PROJECT_CHARS);
  }

  async function requestOnce(requestMessages: Message[], thinkingMode: boolean, controller: AbortController, onContent: (text: string) => void, onStatus: (text: string) => void) {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ messages: requestMessages, thinking: thinkingMode, projectContext: projectContext() })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail ? `${data.error || "NVIDIA request failed"}\n${data.detail}` : data.error || `Request failed: HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("NVIDIA returned no response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let cleanDone = false;
    const process = (packet: string) => {
      const line = packet.split(/\r?\n/).find(x => x.startsWith("data:"));
      if (!line) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") { cleanDone = true; return; }
      let data: any; try { data = JSON.parse(raw); } catch { return; }
      if (data.type === "content") { const chunk = String(data.content || ""); answer += chunk; onContent(chunk); }
      else if (data.type === "status") onStatus(String(data.content || "Thinking…"));
      else if (data.type === "error") throw new Error(data.error || "Generation failed");
      else if (data.type === "done") cleanDone = true;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const packets = buffer.split(/\r?\n\r?\n/); buffer = packets.pop() || "";
      for (const packet of packets) process(packet);
    }
    buffer += decoder.decode(); if (buffer.trim()) process(buffer);
    return { answer, cleanDone };
  }

  async function send(custom?: string) {
    const text = (custom ?? input).trim(); if (!text || loading) return;
    const id = activeChat || crypto.randomUUID();
    const userMessages: Message[] = [...messages, { role: "user", content: text }];
    setActiveChat(id); setInput(""); setLoading(true); setStatus(thinking ? "Thinking…" : "Generating…"); setNotice("");
    setMessages([...userMessages, { role: "assistant", content: "" }]); saveChat(userMessages, id);
    const controller = new AbortController(); abortRef.current = controller;
    let fullAnswer = "";
    let requestMessages = userMessages;
    try {
      for (let round = 0; round < MAX_CONTINUATIONS; round++) {
        const before = fullAnswer.length;
        const result = await requestOnce(requestMessages, thinking, controller, chunk => {
          fullAnswer += chunk;
          setMessages(cur => { const next = [...cur]; next[next.length - 1] = { role: "assistant", content: fullAnswer }; return next; });
        }, setStatus);
        const produced = fullAnswer.length - before;
        if (result.cleanDone) break;
        if (!produced) throw new Error("The connection ended before NVIDIA returned more text. Please retry.");
        if (round === MAX_CONTINUATIONS - 1) {
          setNotice("Response reached the automatic continuation limit. You can press Continue to finish it.");
          break;
        }
        setStatus(`Response was cut off — continuing automatically (${round + 2}/${MAX_CONTINUATIONS})…`);
        requestMessages = [...userMessages, { role: "assistant", content: fullAnswer }, { role: "user", content: "Continue exactly where you stopped. Do not repeat previous text. Finish the requested answer/project. If generating files, continue with the next missing FILE blocks and keep each file complete." }];
      }
      if (!fullAnswer.trim()) throw new Error("NVIDIA returned no final answer.");
      saveChat([...userMessages, { role: "assistant", content: fullAnswer }], id);
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError" ? "Generation stopped." : error instanceof Error ? error.message : "Unknown error";
      const final = fullAnswer ? `${fullAnswer}\n\n⚠️ **Generation interrupted:** ${message}\nUse **Continue** to resume.` : `❌ **Error:** ${message}`;
      setMessages([...userMessages, { role: "assistant", content: final }]); saveChat([...userMessages, { role: "assistant", content: final }], id);
    } finally { abortRef.current = null; setLoading(false); setStatus(""); }
  }

  async function continueLast() {
    if (loading || !messages.length) return;
    const last = messages[messages.length - 1]; if (last.role !== "assistant") return;
    const user = [...messages].reverse().find(m => m.role === "user"); if (!user) return;
    const base = messages.slice(0, -1);
    setMessages(base); await send("Continue exactly where the previous response stopped. Do not repeat previous text. Finish the requested answer/project and continue any FILE blocks.");
  }

  async function copy(text: string) { try { await navigator.clipboard.writeText(text); setNotice("Code copied."); } catch { setNotice("Copy failed."); } }
  function downloadFile(file: GeneratedFile) {
    const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = safePath(file.path); document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  async function exportProject() {
    const generated = messages.flatMap(m => m.role === "assistant" ? extractGeneratedFiles(m.content) : []);
    const unique = Array.from(new Map(generated.map(f => [safePath(f.path), { ...f, path: safePath(f.path) }])).values());
    if (!unique.length) { setNotice("No structured FILE blocks found. Ask the AI to generate the complete project using FILE: path format."); return; }
    setExporting(true);
    try {
      const zip = new JSZip(); unique.forEach(f => zip.file(f.path, f.content));
      if (projectFiles.length) { const folder = zip.folder("uploaded-context"); projectFiles.forEach(f => folder?.file(safePath(f.path), f.content)); }
      zip.file("README-EXPORT.txt", `Generated by Nemotron Code AI\nGenerated files: ${unique.length}\n\nRun the project according to package.json and README.md.`);
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${(projectName || "nemotron-project").replace(/\.zip$/i, "")}-complete.zip`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setNotice(`ZIP ready: ${unique.length} generated files exported.`);
    } catch (error) { setNotice(`ZIP export failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    finally { setExporting(false); }
  }

  const generatedFiles = useMemo(() => Array.from(new Map(messages.flatMap(m => m.role === "assistant" ? extractGeneratedFiles(m.content) : []).map(f => [safePath(f.path), { ...f, path: safePath(f.path) }])).values()), [messages]);
  const suggestions = [["🐍 Build Python App", "Create a complete Python task manager application."], ["⚛️ React Component", "Create a modern React dashboard component."], ["🐛 Fix My Error", "Help me debug this error and provide the fixed code."], ["🌐 Build Website", "Create a complete modern responsive website from my requirements. Use FILE: path format for every file."]];

  return <main className="app">
    <aside className="sidebar">
      <div className="logo"><div className="logo-icon">⚡</div><div><h1>Nemotron Code</h1><span>AI Coding Assistant</span></div></div>
      <button className="new-chat" onClick={newChat}>＋ New Chat</button>
      <div className="history-section"><div className="history-title"><span>CHAT HISTORY</span>{history.length > 0 && <button onClick={() => persist([])}>Clear</button>}</div><div className="history-list">{history.length === 0 ? <div className="history-empty">Your chats will appear here.</div> : history.map(chat => <div className={`history-item ${activeChat === chat.id ? "active" : ""}`} key={chat.id}><button className="history-open" onClick={() => openChat(chat)}>💬 <span>{chat.title}</span></button><button className="history-delete" onClick={() => removeChat(chat.id)}>×</button></div>)}</div></div>
      <div className="sidebar-section"><p>QUICK ACTIONS</p><button onClick={() => send("Write production-ready code for my project.")}>✨ Generate Code</button><button onClick={() => send("Help me debug my code and explain the error.")}>🐛 Fix Error</button><button onClick={() => send("Explain this code in simple language.")}>📖 Explain Code</button><button onClick={() => send("Optimize and improve this code.")}>🚀 Optimize</button></div>
      <div className="upload-card"><strong>📦 Project Uploads</strong><p>Attach files, ZIP projects or images using the + button.</p><button className="upload-button wide" onClick={() => fileRef.current?.click()}>📎 Upload files</button><input ref={fileRef} hidden type="file" multiple onChange={e => addFiles(e.target.files)} /><input ref={zipRef} hidden type="file" accept=".zip,application/zip" onChange={e => e.target.files?.[0] && addZip(e.target.files[0])} /><input ref={imageRef} hidden type="file" accept="image/*" multiple onChange={e => addFiles(e.target.files)} />{files.length > 0 && <div className="upload-list">{files.slice(-6).map(f => <span className="upload-pill" key={f.id}>{f.kind === "image" ? "🖼️" : "📎"} {f.name}<button onClick={() => removeAttachment(f.id)}>×</button></span>)}</div>}<div className="upload-note">ZIP parser skips node_modules, .next, .git and build folders.</div></div>
      <div className="sidebar-bottom"><div className="model-card"><span className="status-dot"/><div><strong>Nemotron 3 Ultra</strong><small>550B total · 55B active</small></div></div><label className="thinking-toggle"><span>🧠 Thinking Mode</span><input type="checkbox" checked={thinking} onChange={e => setThinking(e.target.checked)} /></label></div>
    </aside>
    <section className="chat-area">
      <header className="header"><div><h2>AI Coding Assistant</h2><p>Powered by NVIDIA Nemotron 3 Ultra</p></div><div className="header-actions">{generatedFiles.length > 0 && <button className="export-button" onClick={exportProject} disabled={exporting}>{exporting ? "⏳ Building ZIP…" : "📦 Download Complete ZIP"}<span>{generatedFiles.length} files</span></button>}<div className="header-status"><span/>Online</div></div></header>
      <div className="messages">
        {messages.length === 0 ? <div className="welcome"><div className="welcome-icon">⚡</div><h2>What do you want to build?</h2><p>Create code, fix bugs, understand projects, upload files, and export complete websites as ZIP.</p><div className="suggestions">{suggestions.map(([label, prompt]) => <button key={label} onClick={() => send(prompt)}><strong>{label}</strong></button>)}</div></div> : messages.map((message, index) => {
          const generated = message.role === "assistant" ? extractGeneratedFiles(message.content) : [];
          return <div className={`message ${message.role}`} key={index}><div className="avatar">{message.role === "user" ? "U" : "⚡"}</div><div className="message-content">{message.role === "assistant" ? <><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code({ children, className, ...props }) { const text = String(children).replace(/\n$/, ""); if (className?.includes("language-")) return <div className="code-wrapper"><button className="copy-button" onClick={() => copy(text)}>Copy</button><pre><code className={className} {...props}>{text}</code></pre></div>; return <code {...props}>{children}</code>; } }}>{message.content || (loading ? status || "Generating…" : "")}</ReactMarkdown>{generated.length > 0 && <div className="generated-files"><div className="generated-title">📁 Generated project files <span>{generated.length}</span></div>{generated.map(file => <div className="generated-file" key={file.path}><span>📄 {file.path}</span><button onClick={() => downloadFile(file)}>⬇ Download</button></div>)}<button className="export-inline" onClick={exportProject}>📦 Download all as ZIP</button></div>}{!loading && index === messages.length - 1 && message.content.includes("Generation interrupted") && <button className="export-inline" onClick={continueLast}>▶ Continue response</button>}</> : <p>{message.content}</p>}</div></div>;
        })}<div ref={bottomRef}/>
      </div>
      <div className="input-container"><div className="attachment-preview">{files.map(file => <div className="attachment-chip" key={file.id}>{file.kind === "image" && file.url ? <img src={file.url} alt=""/> : <span>📎</span>}<span>{file.name}</span><button onClick={() => removeAttachment(file.id)}>×</button></div>)}</div><div className="input-box" ref={menuRef}><div className="plus-wrap"><button className="plus-button" aria-label="Attach files" onClick={() => setMenuOpen(x => !x)}>＋</button>{menuOpen && <div className="attach-menu"><button onClick={() => fileRef.current?.click()}>📎 <span><b>Files</b><small>Any file type</small></span></button><button onClick={() => zipRef.current?.click()}>📦 <span><b>Project ZIP</b><small>Read website/code structure</small></span></button><button onClick={() => imageRef.current?.click()}>🖼️ <span><b>Images</b><small>Attach image references</small></span></button></div>}</div><textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={projectFiles.length ? "Ask about the uploaded project…" : "Ask anything about programming…"} rows={1} disabled={loading}/><button className="send-button" onClick={() => loading ? abortRef.current?.abort() : send()} disabled={!loading && !input.trim()}>{loading ? "■" : "➤"}</button></div><p className="hint">{status || notice || "＋ Attach files · Enter to send · Shift + Enter for new line · Chats save in this browser"}</p></div>
    </section>
  </main>;
}
