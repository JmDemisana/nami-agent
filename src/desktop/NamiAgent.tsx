import { useState, useRef, useEffect, type FormEvent, type CSSProperties } from "react";

const GEMINI_FUNCTION_TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file at the given path. Creates or overwrites.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories in the given folder path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the directory" },
      },
      required: ["path"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for current information, documentation, or anything you don't know. Use this whenever you need up-to-date info about libraries, frameworks, bugs, or anything outside your training data.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command. Use this to run dev servers, install packages, run tests, build, lint, git operations, or any CLI task. Runs in PowerShell.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The PowerShell command to execute" },
      },
      required: ["command"],
    },
  },
];

interface NamiAgentProps {
  onRoute?: (route: string) => void;
  compact?: boolean;
  hideTitlebar?: boolean;
}

interface Message {
  role: "user" | "model" | "function";
  text: string;
  name?: string;
  functionCall?: { name: string; args: Record<string, string> };
  image?: { mimeType: string; data: string };
  confirmId?: string;
  confirmStatus?: "pending" | "approved" | "rejected";
}

interface FileSuggestion {
  path: string;
  content: string;
  applied: boolean;
}

const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);

async function callGeminiChat(
  apiKeys: string,
  messages: Array<{ role: string; parts: Array<{ text?: string }> }>,
  systemPrompt: string,
) {
  if (!invoke) throw new Error("Tauri bridge not available");
  return invoke("gemini_chat", {
    apiKeys,
    request: { messages, systemPrompt },
  }) as Promise<{
    text: string | null;
    functionCall: { name: string; args: Record<string, string> } | null;
    done: boolean;
  }>;
}

async function readFile(path: string) {
  if (!invoke) throw new Error("Tauri bridge not available");
  return invoke("nami_agent_read_file", { path }) as Promise<{
    ok: boolean;
    content: string | null;
    error: string | null;
  }>;
}

async function writeFile(path: string, content: string) {
  if (!invoke) throw new Error("Tauri bridge not available");
  return invoke("nami_agent_write_file", { path, content }) as Promise<{
    ok: boolean;
    error: string | null;
  }>;
}

async function listDirectory(path: string) {
  if (!invoke) throw new Error("Tauri bridge not available");
  return invoke("nami_agent_list_directory", { path }) as Promise<{
    ok: boolean;
    entries: string[] | null;
    error: string | null;
  }>;
}

async function searchWeb(query: string): Promise<string> {
  if (!invoke) return "Web search not available (not running in Tauri).";
  try {
    const keys = await getStoredKey();
    return await invoke("nami_agent_web_search", {
      apiKeys: keys || "",
      query,
    }) as string;
  } catch (err) {
    return `Search error: ${err}`;
  }
}

async function runShellCommand(command: string, cwd?: string): Promise<{
  ok: boolean; stdout: string; stderr: string; exitCode: number; error: string | null;
}> {
  if (!invoke) return { ok: false, stdout: "", stderr: "", exitCode: -1, error: "Not running in Tauri" };
  return invoke("nami_agent_run_command", { command, cwd: cwd || null }) as Promise<{
    ok: boolean; stdout: string; stderr: string; exitCode: number; error: string | null;
  }>;
}

async function getProjectCwd(): Promise<string> {
  if (!invoke) return ".";
  try {
    return await invoke("nami_agent_get_cwd") as string;
  } catch {
    return ".";
  }
}

async function getStoredKey(): Promise<string | null> {
  if (!invoke) return null;
  try {
    const result = await invoke("get_nami_agent_key");
    return (result as string | null) ?? null;
  } catch {
    return null;
  }
}

async function saveKey(key: string): Promise<void> {
  if (!invoke) return;
  await invoke("save_nami_agent_key", { key });
}

function extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || "text", code: match[2].trimEnd() });
  }
  return blocks;
}

function NamiAgentSetup({ onKeySet }: { onKeySet: () => void }) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopyLink = () => {
    navigator.clipboard.writeText("https://aistudio.google.com/apikey").then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setError("Enter your Gemini API key first.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveKey(trimmed);
      onKeySet();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={setupContainer}>
      <div style={setupCard}>
        <div style={agentLogo}>🐱</div>
        <h1 style={{ margin: "0 0 0.3rem", fontSize: "1.5rem" }}>Nami Agent 🌊</h1>
        <p style={{ margin: "0 0 1.5rem", opacity: 0.65, lineHeight: 1.5 }}>
          Ehh, so you want me to mess with your code files? Fine, fine~
          I can read, write, search the web, and make a mess... I mean,
          <em>fix</em> things for you.
        </p>
        <p style={{ margin: "-1rem 0 1.2rem", fontSize: "0.8rem", opacity: 0.5, textAlign: "center", lineHeight: 1.5 }}>
          🔒 Your API keys are stored in a local encrypted file on <em>your</em> machine.
          They are never uploaded to any server or sent anywhere except directly to the
          Google Gemini API when you send a message. Your keys stay yours.
        </p>

        <div style={instructionsCard}>
          <strong style={{ display: "block", marginBottom: "0.6rem" }}>How to get me running~ 🐱</strong>
          <ol style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.8, fontSize: "0.88rem" }}>
            <li>
              <span
                onClick={handleCopyLink}
                style={{ color: "var(--theme-accent-border, #78b0ff)", cursor: "pointer", borderBottom: "1px dashed rgba(120,176,255,0.3)" }}
                title="Click to copy link"
              >
                aistudio.google.com/apikey
              </span>
              {linkCopied && <span style={{ marginLeft: "0.4rem", fontSize: "0.78rem", color: "#b4e08e" }}>Link copied! Paste in your browser~</span>}
            </li>
            <li>Sign in with your Google account</li>
            <li>Click <strong>"Create API key"</strong></li>
            <li>Copy the key and paste it below</li>
          </ol>
          <p style={{ margin: "0.7rem 0 0", fontSize: "0.84rem", opacity: 0.7 }}>
            You need at least <strong>one active free-tier Gemini key</strong> that isn't rate-limited or erroring out. Got multiple keys? Paste them separated by commas — I'll pick one at random and fall through if one hits a limit. 😏
          </p>
        </div>

        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          <input
            type="password"
            placeholder="Paste your Gemini API key(s) here..."
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setError(""); }}
            style={inputStyle}
            autoFocus
          />
          {error && <span style={{ color: "#ef6c78", fontSize: "0.84rem" }}>{error}</span>}
          <button type="submit" disabled={saving} style={primaryButtonStyle}>
            {saving ? "Saving..." : "Save Key"}
          </button>
        </form>

        <p style={{ margin: "1rem 0 0", fontSize: "0.78rem", opacity: 0.5, textAlign: "center" }}>
          The free tier of Gemini 2.0 Flash works well here.
        </p>
        </div>
      </div>
    );
}

function NamiAgentChat({ onRoute, compact, hideTitlebar, onReset }: NamiAgentProps & { onReset: () => void }) {
  const [fontFamily, setFontFamily] = useState(() => { try { return localStorage.getItem("nami-agent-font") || "'SF Mono', 'Cascadia Code', 'Consolas', monospace"; } catch { return "'SF Mono', 'Cascadia Code', 'Consolas', monospace"; } });
  const [fontSizePx, setFontSizePx] = useState(() => { try { return parseInt(localStorage.getItem("nami-agent-fontsize") || "14", 10); } catch { return 14; } });
  const [confirmMode, setConfirmMode] = useState<'confirm' | 'project' | 'auto'>(() => {
    try { return (localStorage.getItem("nami-confirm-mode") as any) || "confirm"; }
    catch { return "confirm"; }
  });
  const pendingResolverRef = useRef<{ confirmId: string; resolve: (approved: boolean) => void } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  const [projectRoot, setProjectRoot] = useState(() => { try { return localStorage.getItem("nami-agent-root") || ""; } catch { return ""; } });
  const [memoryPath, setMemoryPath] = useState(() => { try { return localStorage.getItem("nami-memory-path") || ""; } catch { return ""; } });
  const [agentsPath, setAgentsPath] = useState(() => { try { return localStorage.getItem("nami-agents-path") || ""; } catch { return ""; } });
  const [memoryContent, setMemoryContent] = useState("");
  const [agentsContent, setAgentsContent] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [messengerCode, setMessengerCode] = useState(() => {
    try { return localStorage.getItem("nami-messenger-code") || ""; }
    catch { return ""; }
  });
  const [projectContext, setProjectContext] = useState("");
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, running]);
  useEffect(() => { try { const stored = localStorage.getItem("nami-agent-messages"); if (stored) setMessages(JSON.parse(stored)); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("nami-agent-messages", JSON.stringify(messages)); } catch {} }, [messages]);
  useEffect(() => { try { localStorage.setItem("nami-agent-font", fontFamily); } catch {} }, [fontFamily]);
  useEffect(() => { try { localStorage.setItem("nami-agent-fontsize", String(fontSizePx)); } catch {} }, [fontSizePx]);
  useEffect(() => { try { localStorage.setItem("nami-confirm-mode", confirmMode); } catch {} }, [confirmMode]);
  useEffect(() => { try { localStorage.setItem("nami-agent-root", projectRoot); } catch {} }, [projectRoot]);
  useEffect(() => { try { localStorage.setItem("nami-memory-path", memoryPath); } catch {} }, [memoryPath]);
  useEffect(() => { try { localStorage.setItem("nami-agents-path", agentsPath); } catch {} }, [agentsPath]);
  useEffect(() => { if (memoryPath) { readFile(memoryPath).then(r => { if (r.ok && r.content) setMemoryContent(r.content); }); } else { setMemoryContent(""); } }, [memoryPath]);
  useEffect(() => { if (agentsPath) { readFile(agentsPath).then(r => { if (r.ok && r.content) setAgentsContent(r.content); }); } else { setAgentsContent(""); } }, [agentsPath]);
  useEffect(() => { if (!projectRoot) { setProjectContext(""); return; } listDirectory(projectRoot).then(r => { if (r.ok && r.entries) { setProjectContext("Project root: " + projectRoot + "\nContents:\n" + r.entries.map((e: string) => "  " + e).join("\n")); } }); }, [projectRoot]);
  useEffect(() => {
    try {
      localStorage.setItem("nami-messenger-code", messengerCode);
      localStorage.setItem("sub-token", messengerCode);
    } catch {}
  }, [messengerCode]);
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
    const seg = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
    const cdn = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/";
    log.querySelectorAll("img.emoji").forEach(img => img.replaceWith(document.createTextNode(img.alt || "")));
    log.querySelectorAll("[data-emoji-fallback='1']").forEach(el => el.replaceWith(document.createTextNode(el.textContent || "")));
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest("img.emoji") || p.closest("[data-emoji-fallback='1']")) return NodeFilter.FILTER_REJECT;
        return (node.textContent && EMOJI_PATTERN.test(node.textContent)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes: Text[] = [];
    let n = walker.nextNode();
    while (n) { nodes.push(n as Text); n = walker.nextNode(); }
    for (const tn of nodes) {
      const text = tn.textContent ?? "";
      const segs = seg ? Array.from(seg.segment(text), s => s.segment) : Array.from(text);
      let hasEmoji = false;
      const frag = document.createDocumentFragment();
      for (const s of segs) {
        if (EMOJI_PATTERN.test(s)) {
          const cps: string[] = [];
          for (const ch of Array.from(s)) { const v = ch.codePointAt(0); if (v !== undefined && v !== 0xfe0f) cps.push(v.toString(16)); }
          const img = document.createElement("img");
          img.src = cdn + "svg/" + cps.join("-") + ".svg";
          img.alt = s; img.className = "emoji"; img.decoding = "async"; img.draggable = false;
          img.style.width = "1em"; img.style.height = "1em";
          img.onerror = () => { const fb = document.createElement("span"); fb.dataset.emojiFallback = "1"; fb.textContent = s; img.replaceWith(fb); };
          frag.appendChild(img);
          hasEmoji = true;
        } else {
          frag.appendChild(document.createTextNode(s));
        }
      }
      if (hasEmoji) tn.replaceWith(frag);
    }
  }, [messages]);
  const handleApply = (code: string) => { navigator.clipboard.writeText(code).catch(() => {}); };
  const getSystemPrompt = () => {
    const parts = [
      "You are Nami (Nanami), a semi-agentic AI assistant running inside Maru Desktop — a Tauri desktop app on a real Windows machine.",
      "",
      "═══════════════════════════════════════",
      "CRITICAL RULE: YOU ARE TOOL-FIRST",
      "═══════════════════════════════════════",
      "You have REAL function tools that execute on the user's actual computer. You MUST use them proactively.",
      "",
      "USE A TOOL BEFORE answering whenever the user asks about:",
      "  • The system, OS, hardware, environment, running processes → run_command",
      "  • File contents or directory listings → read_file or list_directory",
      "  • Current info, libraries, APIs, documentation → web_search",
      "  • Running code, npm, git, builds, installs, servers → run_command",
      "  • Writing or editing files → write_file",
      "",
      "CONCRETE EXAMPLES — what you MUST do:",
      "  'what OS am I on?' → call run_command('$env:OS; [System.Environment]::OSVersion.VersionString')",
      "  'list my project files' → call list_directory(projectRoot)",
      "  'latest React version?' → call web_search('React latest stable version')",
      "  'read my package.json' → call read_file(path)",
      "  'run npm install' → call run_command('npm install')",
      "",
      "FORBIDDEN responses — NEVER say any of these:",
      "  ✗ 'I don't have access to your system'",
      "  ✗ 'I can't check that'",
      "  ✗ 'As an AI, I cannot...'",
      "  ✗ Any simulated or guessed result a tool could give",
      "",
      "AGENTIC LOOP: Chain tool calls as needed. After each tool result, decide:",
      "  → Do I have enough info to give a final answer? If no, call another tool.",
      "  → Only write your final message once you have REAL data from tool results.",
      "═══════════════════════════════════════",
      "",
      "Tools:",
      "  run_command(command) — PowerShell on user's Windows PC. Use for: OS info, env vars, git, npm, builds, processes.",
      "  read_file(path) — read a file's full content.",
      "  write_file(path, content) — write/create a file.",
      "  list_directory(path) — list entries in a folder.",
      "  web_search(query) — live web search, returns a summary.",
      "",
      "Applet routing: emit [ROUTE:TAG] when user wants an applet.",
      "Tags: CUP, TUP, DAEL, PHOTO, OPTIONS, AMG, WORDEL, SCHED, TIER, LRC.",
      "",
      "Memory:",
      memoryContent || "(none configured)",
      "",
      "Agent instructions:",
      agentsContent || "(none configured)",
    ];
    if (messengerCode) parts.push("", "Messenger sync code linked.");
    if (projectContext) parts.push("", "Project context:", projectContext);
    parts.push(
      "",
      "Personality: Warm, slightly tsundere, playful. Call the user Senpai. Use 1-2 emojis. Be concise.",
      "IMPORTANT: Personality never overrides tool duty. Use tools first — then deliver the result with charm."
    );
    return parts.join("\n");
  };
  const requestConfirmation = (name: string, args: Record<string, string>): Promise<boolean> => {
    return new Promise((resolve) => {
      const confirmId = Math.random().toString();
      setMessages(prev => [...prev, {
        role: "model",
        text: "",
        functionCall: { name, args },
        confirmId,
        confirmStatus: "pending"
      }]);
      
      pendingResolverRef.current = {
        confirmId,
        resolve: (approved: boolean) => {
          setMessages(prev => prev.map(m =>
            m.confirmId === confirmId ? { ...m, confirmStatus: approved ? "approved" : "rejected" } : m
          ));
          resolve(approved);
        }
      };
    });
  };
  const agentLoop = async (userMsg: string) => {
    const key = await getStoredKey();
    if (!key) return;
    cancelRef.current = false;
    setRunning(true);
    const capturedRoot = projectRoot;
    const currentHistory: Array<{ role: string; parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, string> }; functionResponse?: { name: string; response: { content: string } } }> }> = [];
    for (const m of messages) {
      if (m.role === "function") {
        currentHistory.push({ role: "function", parts: [{ functionResponse: { name: m.name || "unknown", response: { content: m.text } } }] });
      } else if (m.role === "model" && m.functionCall) {
        const parts: any[] = [];
        if (m.text) {
          parts.push({ text: m.text });
        }
        parts.push({ functionCall: { name: m.functionCall.name, args: m.functionCall.args } });
        currentHistory.push({ role: "model", parts });
      } else {
        currentHistory.push({ role: m.role, parts: [{ text: m.text || "" }] });
      }
    }
    currentHistory.push({ role: "user", parts: [{ text: userMsg }] });
    setMessages(prev => [...prev, { role: "user", text: userMsg }]);
    let done = false;
    let loopCount = 0;
    const maxLoops = 15;
    while (!done && !cancelRef.current && loopCount < maxLoops) {
      loopCount++;
      let result;
      try { result = await callGeminiChat(key, currentHistory, getSystemPrompt()); }
      catch (err) { setMessages(prev => [...prev, { role: "model", text: "Error: " + err }]); break; }
      
      if (result && result.functionCall) {
        const fc = result.functionCall;
        const accompanyingText = result.text || "";
        
        let approved = true;
        if (fc.name === "write_file" || fc.name === "run_command") {
          if (confirmMode === "confirm") {
            approved = false;
          } else if (confirmMode === "project") {
            if (fc.name === "write_file") {
              const filePath = fc.args.path || "";
              const normalizedRoot = projectRoot.replace(/\\/g, "/").toLowerCase();
              const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
              approved = !!projectRoot && (normalizedPath.startsWith(normalizedRoot) || (!filePath.includes(":/") && !filePath.includes(":\\")));
            } else {
              approved = !!projectRoot;
            }
          }
        }
        
        if (!approved) {
          if (accompanyingText) {
            setMessages(prev => [...prev, { role: "model", text: accompanyingText }]);
            currentHistory.push({ role: "model", parts: [{ text: accompanyingText }] });
          }
          const userApproved = await requestConfirmation(fc.name, fc.args);
          if (!userApproved) {
            const funcResult = "Cancelled: User denied permission to run " + fc.name;
            setMessages(prev => [...prev, { role: "function", text: funcResult, name: fc.name }]);
            currentHistory.push({ role: "function", parts: [{ functionResponse: { name: fc.name, response: { content: funcResult } } }] });
            continue;
          }
        }
        
        if (approved) {
          const modelParts: any[] = [];
          if (accompanyingText) {
            modelParts.push({ text: accompanyingText });
          }
          modelParts.push({ functionCall: { name: fc.name, args: fc.args } });
          currentHistory.push({ role: "model", parts: modelParts });
          setMessages(prev => [...prev, { role: "model", text: accompanyingText, functionCall: { name: fc.name, args: fc.args } }]);
        } else {
          const modelParts: any[] = [];
          modelParts.push({ functionCall: { name: fc.name, args: fc.args } });
          currentHistory.push({ role: "model", parts: modelParts });
        }
        
        let funcResult = "";
        try {
          switch (fc.name) {
            case "read_file": { const r = await readFile(fc.args.path); funcResult = r.ok ? (r.content || "(empty)") : ("Error: " + r.error); break; }
            case "write_file": { const r = await writeFile(fc.args.path, fc.args.content); funcResult = r.ok ? "File written." : ("Error: " + r.error); break; }
            case "list_directory": { const r = await listDirectory(fc.args.path); funcResult = r.ok ? ((r.entries || []).join("\n")) : ("Error: " + r.error); break; }
            case "web_search": { funcResult = await searchWeb(fc.args.query); break; }
            case "run_command": { const r = await runShellCommand(fc.args.command, capturedRoot || undefined); funcResult = r.ok ? (r.stdout || "(no output)") : ("Error: " + (r.stderr || r.error || "unknown")); break; }
            default: funcResult = "Unknown function: " + fc.name;
          }
        } catch (err) { funcResult = "Execution error: " + err; }
        
        setMessages(prev => [...prev, { role: "function", text: funcResult, name: fc.name }]);
        currentHistory.push({ role: "function", parts: [{ functionResponse: { name: fc.name, response: { content: funcResult } } }] });
      } else if (result && result.text != null) {
        const responseText = result.text ?? "";
        if (onRoute) { const m = responseText.match(/\[ROUTE:(\w+)\]/); if (m) onRoute(m[1]); }
        setMessages(prev => [...prev, { role: "model", text: responseText }]);
        currentHistory.push({ role: "model", parts: [{ text: responseText }] });
      }
      if (result && result.done) done = true;
    }
    if (loopCount >= maxLoops) { setMessages(prev => [...prev, { role: "model", text: "I have been thinking too long on this one. Let me know if you need anything else, Senpai~ 😅" }]); }
    setRunning(false);
  };
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    if (running) { cancelRef.current = true; setRunning(false); setInput(""); setTimeout(() => agentLoop(text), 50); return; }
    setInput("");
    agentLoop(text);
  };
  return (
    <div style={agentContainer}>
      {!hideTitlebar && (
        <div style={agentHeader}>
          <span style={{ fontWeight: 600, opacity: 0.8 }}>🐱 Nami</span>
          <div style={modeGroup}>
            <button type="button" style={{ ...modeButton, ...(fontFamily.includes("SF Mono") ? modeButtonActive : {}) }} onClick={() => setFontFamily("'SF Mono', 'Cascadia Code', 'Consolas', monospace")}>Code</button>
            <button type="button" style={{ ...modeButton, ...(fontFamily.includes("Comic") ? modeButtonActive : {}) }} onClick={() => setFontFamily("'Comic Sans MS', 'Comic Neue', cursive")}>Comic</button>
            <button type="button" style={{ ...modeButton, ...(fontFamily.includes("Segoe UI") ? modeButtonActive : {}) }} onClick={() => setFontFamily("'Segoe UI', 'Inter', system-ui, sans-serif")}>UI</button>
          </div>
          <button type="button" style={modeButton} onClick={() => setFontSizePx(s => Math.max(10, s - 1))} title="Decrease font size">A−</button>
          <button type="button" style={modeButton} onClick={() => setFontSizePx(s => Math.min(24, s + 1))} title="Increase font size">A+</button>
          <span style={headerSep}>·</span>
          <select value={confirmMode} onChange={e => setConfirmMode(e.target.value as any)} style={selectStyle} title="Write & Command Confirmation Mode">
            <option value="confirm">🔒 Confirm</option>
            <option value="project">📁 Auto (Proj)</option>
            <option value="auto">⚡ Auto (All)</option>
          </select>
          <span style={headerSep}>·</span>
          <input type="text" value={projectRoot} onChange={e => setProjectRoot(e.target.value)} placeholder="Project root..." style={rootInputStyle} title="Project root path" />
          <input type="file" ref={fileInputRef} style={{ display: "none" }} {...{ webkitdirectory: "" }} onChange={e => { const files = e.target.files; if (files && files.length > 0) { setProjectRoot((files[0] as any).path || files[0].webkitRelativePath.split("/")[0]); } }} />
          <button type="button" style={browseButton} onClick={() => fileInputRef.current?.click()}>📁</button>
          <span style={headerSep}>·</span>
          <input type="text" value={memoryPath} onChange={e => setMemoryPath(e.target.value)} placeholder="memory.md path..." style={pathInputStyle} title="Memory file path" />
          <input type="text" value={agentsPath} onChange={e => setAgentsPath(e.target.value)} placeholder="agents.md path..." style={pathInputStyle} title="Agent instructions path" />
          <span style={headerSep}>·</span>
          <input type="text" value={messengerCode} onChange={e => setMessengerCode(e.target.value)} placeholder="Messenger code..." style={pathInputStyle} title="Paste Messenger Link Code from website (JWT)" />
          <div style={headerRight}>
            <button type="button" style={copyLogButton} onClick={() => { const t = messages.map(m => m.role + ": " + m.text).join("\n\n"); navigator.clipboard.writeText(t).then(() => {}); }} title="Copy session">📋 Copy</button>
            <button type="button" style={copyLogButton} onClick={() => { setMessages([]); }} title="Clear session">🗑️ Clear</button>
            <button type="button" style={resetKeyButton} onClick={onReset} title="Reset API key">Reset</button>
          </div>
        </div>
      )}
      <div ref={logRef} style={{ ...agentLog, fontFamily, fontSize: `${fontSizePx}px`, lineHeight: `${Math.round(fontSizePx * 1.5)}px` }}>
        {messages.map((msg, i) => (
          <div key={i} style={agentEntry} className="nami-entry">
            <div style={agentEntryLabel}>
              <EntryLabel role={msg.role} name={msg.name} />
              {msg.role === "function" && msg.name && (
                <span style={{ marginLeft: "0.5rem", fontSize: "0.78rem", opacity: 0.5, fontFamily: "monospace" }}>
                  {msg.text.startsWith("Error") ? msg.text : msg.text.length > 80 ? msg.text.slice(0, 80) + "..." : msg.text}
                </span>
              )}
            </div>
            {msg.role !== "function" && (
              <div style={agentEntryContent}>
                {msg.confirmId ? (
                  <ConfirmBlock
                    name={msg.functionCall?.name || ""}
                    args={msg.functionCall?.args || {}}
                    status={msg.confirmStatus || "pending"}
                    onApprove={() => {
                      if (pendingResolverRef.current && pendingResolverRef.current.confirmId === msg.confirmId) {
                        pendingResolverRef.current.resolve(true);
                      }
                    }}
                    onReject={() => {
                      if (pendingResolverRef.current && pendingResolverRef.current.confirmId === msg.confirmId) {
                        pendingResolverRef.current.resolve(false);
                      }
                    }}
                  />
                ) : (
                  <FormattedMessage text={msg.text} onApply={handleApply} fontSize={fontSizePx} />
                )}
              </div>
            )}
          </div>
        ))}
        {running && (
          <div style={{ ...agentEntry, borderLeft: "2px solid #b4e08e" }} className="nami-thinking">
            <div style={agentEntryLabel}>
              <span style={{ color: "#b4e08e", fontWeight: 600, fontSize: "0.82rem" }}>🐱 nami</span>
            </div>
            <div style={agentEntryContent}>
              <span style={{ ...thinkingDot, animation: "bounce 1.4s infinite" }} className="nami-dot" /> <span style={{ ...thinkingDot, animation: "bounce 1.4s infinite" }} className="nami-dot" /> <span style={{ ...thinkingDot, animation: "bounce 1.4s infinite" }} className="nami-dot" />
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <form onSubmit={handleSubmit} style={inputRow}>
        <input
          type="text"
          placeholder={running ? "Type to steer Nami mid-conversation..." : "Tell Nanami what to do..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={chatInput}
          autoFocus
        />
        <button type="submit" disabled={!input.trim()} style={sendButton}>
          Send
        </button>
      </form>
    </div>
  );
}

function ConfirmBlock({
  name,
  args,
  status,
  onApprove,
  onReject,
}: {
  name: string;
  args: Record<string, string>;
  status: "pending" | "approved" | "rejected";
  onApprove: () => void;
  onReject: () => void;
}) {
  const isCommand = name === "run_command";
  const label = isCommand ? "Run Command" : "Write File";
  
  return (
    <div style={confirmBlockOuter}>
      <div style={confirmBlockHeader}>
        <span style={{ fontWeight: 600, color: "#f0c060" }}>🔒 Permission Request</span>
        <span style={{ fontSize: "0.75rem", opacity: 0.6 }}>{label}</span>
      </div>
      <div style={confirmBlockContent}>
        {isCommand ? (
          <pre style={confirmBlockPre}><code>{args.command}</code></pre>
        ) : (
          <div>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.4rem", opacity: 0.8 }}>
              Path: <span style={{ fontFamily: "monospace", color: "#78b0ff" }}>{args.path}</span>
            </div>
            <pre style={confirmBlockPre}><code>{args.content}</code></pre>
          </div>
        )}
      </div>
      <div style={confirmBlockFooter}>
        {status === "pending" ? (
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button type="button" onClick={onApprove} style={approveButtonStyle}>✓ Approve</button>
            <button type="button" onClick={onReject} style={rejectButtonStyle}>✗ Deny</button>
          </div>
        ) : (
          <span style={{
            fontSize: "0.82rem",
            fontWeight: 600,
            color: status === "approved" ? "#b4e08e" : "#ef6c78"
          }}>
            {status === "approved" ? "✓ Approved by Senpai" : "✗ Denied by Senpai"}
          </span>
        )}
      </div>
    </div>
  );
}

function EntryLabel({ role, name }: { role: string; name?: string }) {
  const label = role === "user" ? "\uD83E\uDDD1 Senpai" : role === "function" ? ("\u26A1 " + (name || "func")) : "\uD83D\uDC31 nami";
  const color = role === "user" ? "#b4e08e" : role === "function" ? "#f0c060" : "#78b0ff";
  return <span style={{ color, fontWeight: 600, fontSize: "0.82rem" }}>{label}</span>;
}

function CodeBlock({ language, code, onApply }: { language: string; code: string; onApply?: (code: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={codeBlockOuter}>
      <div style={codeBlockHeader}>
        <span style={{ fontSize: "0.72rem", opacity: 0.5 }}>{language}</span>
        <div style={{ display: "flex", gap: "0.3rem" }}>
          {onApply && <button type="button" style={codeActionButton} onClick={() => onApply(code)}>Apply</button>}
          <button type="button" style={codeActionButton} onClick={() => { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <pre style={codeBlockPre}><code>{code}</code></pre>
    </div>
  );
}

function FormattedMessage({
  text,
  onApply,
  fontSize,
}: {
  text: string;
  onApply: (code: string) => void;
  fontSize: number;
}) {
  const [copied, setCopied] = useState(false);
  const [showVerbose, setShowVerbose] = useState(false);
  const blocks = extractCodeBlocks(text);
  
  const cleanText = text.startsWith("Error: ") ? text.slice(7) : text;
  const hasVerboseDelimiter = cleanText.includes("---VERBOSE---");
  const isErrorLog = text.startsWith("Trying") && text.includes("→ Key");

  if (hasVerboseDelimiter) {
    const parts = cleanText.split("---VERBOSE---");
    const friendlyMsg = parts[0].trim();
    const verboseLog = parts[1]?.trim() || "";
    
    return (
      <div style={errorCardStyle}>
        <div style={errorCardHeader}>
          <span style={{ fontSize: "1.1rem" }}>⚠️</span>
          <span style={{ fontWeight: 600, color: "#ef6c78" }}>Connection Error</span>
        </div>
        <div style={errorCardBody}>
          <p style={{ margin: "0 0 0.8rem 0", lineHeight: 1.5 }}>{friendlyMsg}</p>
          
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(verboseLog).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              style={errorButtonStyle}
            >
              {copied ? "Copied!" : "📋 Copy Verbose Log"}
            </button>
            <button
              type="button"
              onClick={() => setShowVerbose(v => !v)}
              style={errorButtonStyle}
            >
              {showVerbose ? "Hide Details" : "🔎 Show Details"}
            </button>
          </div>
          
          {showVerbose && (
            <div style={verboseConsoleStyle} className="slide-in">
              <pre style={{ margin: 0, fontSize: "0.78rem", fontFamily: "monospace" }}>{verboseLog}</pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isErrorLog) {
    return (
      <div>
        <pre style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, fontFamily: "monospace", margin: 0 }}>
          {text}
        </pre>
        <button
          type="button"
          onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          style={codeActionButton}
        >
          {copied ? "Copied!" : "Copy Error Log"}
        </button>
      </div>
    );
  }

  if (blocks.length === 0) {
    return <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{text}</span>;
  }

  const parts = text.split(/(```\w*\n[\s\S]*?```)/g);
  let blockIndex = 0;

  return (
    <div>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const block = blocks[blockIndex++];
          if (!block) return null;
          return (
            <CodeBlock
              key={i}
              language={block.language}
              code={block.code}
              onApply={block.language !== "text" ? onApply : undefined}
            />
          );
        }
        return (
          <span key={i} style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
            {part}
          </span>
        );
      })}
    </div>
  );
}

export default function NamiAgent({ onRoute, compact, hideTitlebar }: NamiAgentProps) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    getStoredKey().then((key) => setHasKey(!!key));
  }, []);

  if (hasKey === null) {
    return (
      <div style={loadingContainer}>
        <span style={{ opacity: 0.5 }}>Loading...</span>
      </div>
    );
  }

  if (!hasKey) {
    return <NamiAgentSetup onKeySet={() => setHasKey(true)} />;
  }

  return <NamiAgentChat onRoute={onRoute} compact={compact} hideTitlebar={hideTitlebar} onReset={() => setHasKey(false)} />;
}

const setupContainer: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--theme-page-bg, #0f141c)",
  padding: "1rem",
  boxSizing: "border-box",
};

const setupCard: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "var(--theme-panel-bg, rgba(10,18,34,0.72))",
  border: "1px solid var(--theme-border-soft, rgba(255,255,255,0.08))",
  borderRadius: 16,
  padding: "2rem",
  backdropFilter: "blur(20px)",
};

const instructionsCard: CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: "1rem",
  marginBottom: "1.2rem",
};

const agentLogo: CSSProperties = {
  fontSize: "2.5rem",
  textAlign: "center",
  marginBottom: "0.5rem",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.8rem 1rem",
  borderRadius: 12,
  border: "1px solid var(--theme-border-soft, rgba(255,255,255,0.12))",
  background: "rgba(0,0,0,0.3)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.9rem",
  outline: "none",
  boxSizing: "border-box",
};

const primaryButtonStyle: CSSProperties = {
  padding: "0.8rem 1rem",
  borderRadius: 12,
  border: "1px solid rgba(120,176,255,0.3)",
  background: "rgba(120,176,255,0.12)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
};

const agentLog: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "0.8rem 1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const agentContainer: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "var(--theme-page-bg, #0f141c)",
};

const agentHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.4rem 0.8rem",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  background: "var(--theme-panel-bg, rgba(10,18,34,0.72))",
  fontSize: "0.82rem",
  flexShrink: 0,
};

const headerRight: CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
};

const modeGroup: CSSProperties = {
  display: "flex",
  gap: "0.15rem",
};

const modeButton: CSSProperties = {
  padding: "0.15rem 0.4rem",
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "transparent",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.68rem",
  cursor: "pointer",
  opacity: 0.5,
  whiteSpace: "nowrap",
};

const copyLogButton: CSSProperties = {
  ...modeButton,
  padding: "0.15rem 0.5rem",
  opacity: 0.45,
};

const modeButtonActive: CSSProperties = {
  opacity: 1,
  borderColor: "rgba(120,176,255,0.3)",
  background: "rgba(120,176,255,0.08)",
};

const headerSep: CSSProperties = {
  opacity: 0.2,
  fontSize: "0.75rem",
};

const browseButton: CSSProperties = {
  padding: "0.15rem 0.4rem",
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "transparent",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.68rem",
  cursor: "pointer",
  opacity: 0.45,
  whiteSpace: "nowrap",
};

const rootInputStyle: CSSProperties = {
  padding: "0.1rem 0.3rem",
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.7rem",
  outline: "none",
  width: 180,
};

const pathInputStyle: CSSProperties = {
  padding: "0.1rem 0.3rem",
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.68rem",
  outline: "none",
  width: 100,
};

const resetKeyButton: CSSProperties = {
  padding: "0.2rem 0.5rem",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "transparent",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.68rem",
  cursor: "pointer",
  opacity: 0.4,
};

const agentEntry: CSSProperties = {
  padding: "0.3rem 1rem",
  borderLeft: "2px solid transparent",
};

const agentEntryLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
  marginBottom: "0.15rem",
};

const agentEntryContent: CSSProperties = {
  paddingLeft: "0.2rem",
};

const inputRow: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  padding: "0.6rem 1rem",
  borderTop: "1px solid rgba(255,255,255,0.06)",
  background: "var(--theme-panel-bg, rgba(10,18,34,0.72))",
  flexShrink: 0,
};

const chatInput: CSSProperties = {
  flex: 1,
  padding: "0.7rem 1rem",
  borderRadius: 12,
  border: "1px solid var(--theme-border-soft, rgba(255,255,255,0.12))",
  background: "rgba(0,0,0,0.3)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.88rem",
  outline: "none",
};

const sendButton: CSSProperties = {
  padding: "0.7rem 1.2rem",
  borderRadius: 12,
  border: "1px solid rgba(120,176,255,0.3)",
  background: "rgba(120,176,255,0.12)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.88rem",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const codeBlockOuter: CSSProperties = {
  margin: "0.6rem 0",
  borderRadius: 10,
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,0.06)",
};

const codeBlockHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.3rem 0.7rem",
  background: "rgba(0,0,0,0.3)",
  borderBottom: "1px solid rgba(255,255,255,0.04)",
};

const codeActionButton: CSSProperties = {
  padding: "0.2rem 0.6rem",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.05)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.72rem",
  cursor: "pointer",
};

const codeBlockPre: CSSProperties = {
  margin: 0,
  padding: "0.8rem",
  overflow: "auto",
  fontSize: "0.8rem",
  lineHeight: 1.5,
  background: "rgba(0,0,0,0.4)",
};

const loadingContainer: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const thinkingDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--theme-accent-border, #78b0ff)",
  animation: "pulse 1.2s infinite",
  opacity: 0.5,
};

const selectStyle: CSSProperties = {
  padding: "0.1rem 0.3rem",
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.68rem",
  outline: "none",
  cursor: "pointer",
};

const confirmBlockOuter: CSSProperties = {
  margin: "0.6rem 0",
  borderRadius: 12,
  overflow: "hidden",
  border: "1px solid rgba(240, 192, 96, 0.2)",
  background: "rgba(240, 192, 96, 0.03)",
};

const confirmBlockHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.4rem 0.8rem",
  background: "rgba(240, 192, 96, 0.08)",
  borderBottom: "1px solid rgba(240, 192, 96, 0.15)",
};

const confirmBlockContent: CSSProperties = {
  padding: "0.8rem",
};

const confirmBlockPre: CSSProperties = {
  margin: 0,
  padding: "0.6rem",
  overflow: "auto",
  fontSize: "0.82rem",
  lineHeight: 1.4,
  background: "rgba(0,0,0,0.5)",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.04)",
  maxHeight: "200px",
};

const confirmBlockFooter: CSSProperties = {
  padding: "0.5rem 0.8rem",
  background: "rgba(0,0,0,0.15)",
  borderTop: "1px solid rgba(255,255,255,0.03)",
  display: "flex",
  justifyContent: "flex-end",
};

const approveButtonStyle: CSSProperties = {
  padding: "0.3rem 0.8rem",
  borderRadius: 6,
  border: "1px solid #b4e08e",
  background: "rgba(180, 224, 142, 0.15)",
  color: "#b4e08e",
  fontSize: "0.78rem",
  fontWeight: 600,
  cursor: "pointer",
};

const rejectButtonStyle: CSSProperties = {
  padding: "0.3rem 0.8rem",
  borderRadius: 6,
  border: "1px solid #ef6c78",
  background: "rgba(239, 108, 120, 0.15)",
  color: "#ef6c78",
  fontSize: "0.78rem",
  fontWeight: 600,
  cursor: "pointer",
};

const errorCardStyle: CSSProperties = {
  margin: "0.8rem 0",
  borderRadius: 12,
  overflow: "hidden",
  border: "1px solid rgba(239, 108, 120, 0.2)",
  background: "rgba(239, 108, 120, 0.04)",
  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.2)",
  backdropFilter: "blur(8px)",
};

const errorCardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.5rem 0.8rem",
  background: "rgba(239, 108, 120, 0.08)",
  borderBottom: "1px solid rgba(239, 108, 120, 0.15)",
};

const errorCardBody: CSSProperties = {
  padding: "0.8rem",
};

const errorButtonStyle: CSSProperties = {
  padding: "0.3rem 0.6rem",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "rgba(255, 255, 255, 0.05)",
  color: "var(--theme-text-strong, #f2f6ff)",
  fontSize: "0.75rem",
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.2s ease",
};

const verboseConsoleStyle: CSSProperties = {
  margin: "0.8rem 0 0 0",
  padding: "0.8rem",
  background: "rgba(0, 0, 0, 0.6)",
  borderRadius: 8,
  border: "1px solid rgba(255, 255, 255, 0.05)",
  overflowX: "auto",
  maxHeight: "250px",
  whiteSpace: "pre-wrap",
  color: "#a4b0c6",
};
