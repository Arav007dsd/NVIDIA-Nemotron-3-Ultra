"use client";

import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type ProjectFile = {
  path: string;
  content: string;
};

type ImageAttachment = {
  id: string;
  name: string;
  url: string;
  size: number;
};

const MAX_PROJECT_CHARS = 120_000;
const MAX_FILE_CHARS = 24_000;
const MAX_FILES = 60;
const IGNORED_PARTS = ["node_modules/", ".next/", ".git/", "dist/", "build/", "coverage/"];

const TEXT_EXTENSIONS = new Set([
  "ts","tsx","js","jsx","json","css","scss","sass","html","md","mdx","txt","py","pyx",
  "java","kt","go","rs","php","rb","c","cpp","h","hpp","cs","sql","sh","bash","yml","yaml",
  "toml","ini","env","mjs","cjs","astro","vue","svelte","xml","svg"
]);

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

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectName, setProjectName] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [notice, setNotice] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    return () => images.forEach(image => URL.revokeObjectURL(image.url));
  }, [images]);

  const newChat = () => {
    setMessages([]);
    setInput("");
  };

  const clearProject = () => {
    setProjectFiles([]);
    setProjectName("");
    setNotice("Project context cleared.");
  };

  const removeImage = (id: string) => {
    setImages(current => {
      const found = current.find(item => item.id === id);
      if (found) URL.revokeObjectURL(found.url);
      return current.filter(item => item.id !== id);
    });
  };

  async function handleZip(file: File) {
    setNotice("Reading ZIP project...");
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(entry =>
        !entry.dir &&
        !IGNORED_PARTS.some(part => entry.name.includes(part)) &&
        isTextFile(entry.name)
      );

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

      setProjectFiles(files);
      setProjectName(file.name);
      setNotice(
        `Loaded ${files.length} text files from ${file.name}. ${formatBytes(total)} of code/context is ready.`
      );
      setInput("Explain this uploaded project: architecture, important files, how it works, and what I should change next.");
    } catch (error) {
      console.error(error);
      setNotice("Could not read this ZIP file.");
    }
  }

  function handleImages(fileList: FileList | null) {
    if (!fileList?.length) return;
    const incoming = Array.from(fileList).slice(0, 8).map(file => ({
      id: `${file.name}-${file.lastModified}-${Math.random()}`,
      name: file.name,
      url: URL.createObjectURL(file),
      size: file.size,
    }));
    setImages(current => [...current, ...incoming].slice(-8));
    setNotice(
      "Images attached. Nemotron 3 Ultra is currently a text-output model, so these images are shown as references but are not visually analyzed by the model."
    );
  }

  function buildProjectContext() {
    if (!projectFiles.length && !images.length) return "";
    const files = projectFiles.map(file =>
      `\n===== FILE: ${file.path} =====\n${file.content}`
    ).join("\n");

    const imageList = images.length
      ? `\n\n===== IMAGE REFERENCES =====\n${images.map(image => `- ${image.name} (${formatBytes(image.size)})`).join("\n")}`
      : "";

    return `The user uploaded project context. Use it when answering. Do not claim to have visually analyzed images; image files are reference metadata only.\nProject ZIP: ${projectName || "none"}\n${files}${imageList}`;
  }

  async function sendMessage(customPrompt?: string) {
    const text = (customPrompt ?? input).trim();
    if (!text || loading) return;

    const updated = [...messages, { role: "user" as const, content: text }];
    setMessages([...updated, { role: "assistant", content: "" }]);
    setInput("");
    setLoading(true);
    setNotice("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updated,
          thinking,
          projectContext: buildProjectContext(),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Request failed");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          const data = JSON.parse(part.slice(6));

          if (data.type === "content") {
            setMessages(current => {
              const copy = [...current];
              const last = copy.length - 1;
              copy[last] = {
                role: "assistant",
                content: copy[last].content + data.content,
              };
              return copy;
            });
          }
          if (data.type === "error") throw new Error(data.error);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setMessages(current => {
        const copy = [...current];
        copy[copy.length - 1] = {
          role: "assistant",
          content: `❌ **Error:** ${message}`,
        };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  async function copyCode(text: string) {
    await navigator.clipboard.writeText(text);
  }

  const suggestions = [
    ["🐍 Build Python App", "Create a complete Python task manager application."],
    ["⚛️ React Component", "Create a modern React dashboard component using Tailwind CSS."],
    ["🐛 Fix My Error", "Help me debug this code. Explain the error and provide the fixed version:\n\n"],
    ["🌐 Build Website", "Create a modern responsive landing page using HTML, CSS and JavaScript."],
  ];

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon">⚡</div>
          <div>
            <h1>Nemotron Code</h1>
            <span>AI Coding Assistant</span>
          </div>
        </div>

        <button className="new-chat" onClick={newChat}>＋ New Chat</button>

        <div className="sidebar-section">
          <p>QUICK ACTIONS</p>
          <button onClick={() => sendMessage("Write clean production-ready code for my project.")}>✨ Generate Code</button>
          <button onClick={() => sendMessage("I have a bug. Help me debug and explain the issue.")}>🐛 Fix Error</button>
          <button onClick={() => sendMessage("Explain this code in simple language:\n\n")}>📖 Explain Code</button>
          <button onClick={() => sendMessage("Optimize and improve this code:\n\n")}>🚀 Optimize</button>
        </div>

        <div className="upload-card">
          <strong>📦 Project Uploads</strong>
          <p>Upload a ZIP of your website/code or attach image references.</p>
          <div className="upload-buttons">
            <button className="upload-button" onClick={() => zipInputRef.current?.click()}>Upload ZIP</button>
            <button className="upload-button" onClick={() => imageInputRef.current?.click()}>Upload Images</button>
          </div>
          <input ref={zipInputRef} type="file" accept=".zip,application/zip" hidden onChange={e => e.target.files?.[0] && handleZip(e.target.files[0])} />
          <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={e => handleImages(e.target.files)} />
          {(projectFiles.length > 0 || images.length > 0) && (
            <div className="upload-list">
              {projectFiles.length > 0 && <span className="upload-pill">📦 {projectName || "project.zip"} · {projectFiles.length} files <button onClick={clearProject}>×</button></span>}
              {images.map(image => <span className="upload-pill" key={image.id}>🖼️ {image.name} <button onClick={() => removeImage(image.id)}>×</button></span>)}
            </div>
          )}
          <div className="upload-note">ZIP parser skips node_modules, .next, .git, build and other generated folders.</div>
        </div>

        <div className="sidebar-bottom">
          <div className="model-card">
            <span className="status" />
            <div><strong>Nemotron 3 Ultra</strong><small>550B total · 55B active</small></div>
          </div>
          <label className="thinking-toggle">
            <span>🧠 Thinking Mode</span>
            <input type="checkbox" checked={thinking} onChange={e => setThinking(e.target.checked)} />
          </label>
        </div>
      </aside>

      <section className="chat-area">
        <header className="header">
          <div><h2>AI Coding Assistant</h2><p>Powered by NVIDIA Nemotron 3 Ultra</p></div>
          <div className="header-status"><span />Online</div>
        </header>

        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-icon">⚡</div>
              <h2>What do you want to build?</h2>
              <p>Ask me to write code, fix bugs, explain errors, or upload a ZIP so I can reason over the project files.</p>
              <div className="suggestions">
                {suggestions.map(([title, prompt]) => (
                  <button key={title} onClick={() => sendMessage(prompt)}><strong>{title}</strong></button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <div key={index} className={`message ${message.role}`}>
              <div className="avatar">{message.role === "user" ? "U" : "⚡"}</div>
              <div className="message-content">
                {message.role === "assistant" ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ children, className, ...props }) {
                        const text = String(children).replace(/\n$/, "");
                        const block = Boolean(className?.includes("language-"));
                        if (block) {
                          return (
                            <div className="code-wrapper">
                              <button className="copy-button" onClick={() => copyCode(text)}>Copy</button>
                              <pre><code className={className} {...props}>{text}</code></pre>
                            </div>
                          );
                        }
                        return <code {...props}>{children}</code>;
                      },
                    }}
                  >
                    {message.content || "Thinking..."}
                  </ReactMarkdown>
                ) : <p>{message.content}</p>}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="input-container">
          {images.length > 0 && (
            <div className="attachment-preview">
              {images.map(image => (
                <div className="image-thumb" key={image.id} title={image.name}>
                  <img src={image.url} alt={image.name} />
                  <button onClick={() => removeImage(image.id)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="input-box">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={projectFiles.length ? "Ask about the uploaded project..." : "Ask anything about programming..."}
              rows={1}
              disabled={loading}
            />
            <button className="send-button" onClick={() => sendMessage()} disabled={loading || !input.trim()}>
              {loading ? "..." : "➤"}
            </button>
          </div>
          <p className="hint">{notice || "Enter to send · Shift + Enter for new line"}</p>
        </div>
      </section>
    </main>
  );
}
