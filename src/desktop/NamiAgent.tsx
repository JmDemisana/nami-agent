import { useState, useRef, useEffect, type FormEvent, type CSSProperties } from "react";

// Inject dot bounce keyframe once
(function injectNamiStyles() {
  if (document.getElementById("nami-agent-styles")) return;
  const s = document.createElement("style");
  s.id = "nami-agent-styles";
  s.textContent = `
    @keyframes namiDotBounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
      40% { transform: translateY(-4px); opacity: 1; }
    }
    .nami-dot { display: inline-block; }
    .nami-entry { transition: background 0.15s; }
    .nami-entry:hover { background: rgba(255,255,255,0.015); }
    select option {
      background-color: #111a2e !important;
      color: #f2f6ff !important;
    }
  `;
  document.head.appendChild(s);
})();

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
    name: "replace_in_file",
    description: "Replace a specific contiguous block of text in a file with new content. Use this for precise modifications to source code files instead of rewriting the entire file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to edit" },
        target: { type: "string", description: "The exact block of code/text in the file to find and replace" },
        replacement: { type: "string", description: "The replacement content to write" },
      },
      required: ["path", "target", "replacement"],
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

const MODEL_OPTIONS = [
  {
    id: "gemini-2.5-flash-lite",
    label: "Lite (2.5 Flash Lite)",
    note: "15 RPM Free",
    maxOutputTokens: 2048,
    thinkingBudget: 0,
  },
  {
    id: "gemini-2.5-flash",
    label: "Flash (2.5 Flash)",
    note: "10 RPM Free",
    maxOutputTokens: 3072,
    thinkingBudget: 0,
  },
  {
    id: "gemini-2.5-pro",
    label: "Pro (2.5 Pro Reasoning)",
    note: "Thinking, 2 RPM Free",
    maxOutputTokens: 8192,
    thinkingBudget: 4096,
  },
  {
    id: "gemini-2.0-flash",
    label: "Flash (2.0 Flash)",
    note: "10 RPM Free",
    maxOutputTokens: 2048,
    thinkingBudget: 0,
  },
  {
    id: "gemini-1.5-pro",
    label: "Pro (1.5 Pro)",
    note: "2 RPM Free",
    maxOutputTokens: 8192,
    thinkingBudget: 0,
  },
  {
    id: "gemini-1.5-flash",
    label: "Flash (1.5 Flash)",
    note: "15 RPM Free",
    maxOutputTokens: 2048,
    thinkingBudget: 0,
  },
];

const MAX_HISTORY_MESSAGES = 14;
const MAX_PROMPT_TEXT_CHARS = 2500;
const MAX_TOOL_RESULT_CHARS = 3500;
const MAX_VISIBLE_TOOL_RESULT_CHARS = 2200;

function clampText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[trimmed for token efficiency]";
}

function formatCommandResult(result: {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
}) {
  const sections = [`exitCode: ${result.exitCode}`];
  if (result.stdout.trim()) sections.push(`stdout:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) sections.push(`stderr:\n${result.stderr.trim()}`);
  if (result.error) sections.push(`error: ${result.error}`);
  return sections.join("\n\n");
}

function summarizeToolFallback(name: string, result: string) {
  const compact = clampText(result, 1200);
  if (name === "run_command") {
    return `I got the command result, but Gemini returned an empty final turn. Here's the useful part, Senpai:\n\n${compact}`;
  }
  return `I got the ${name} result, but Gemini returned an empty final turn. Here's what came back:\n\n${compact}`;
}

async function callGeminiChat(
  apiKeys: string,
  messages: Array<{ role: string; parts: Array<{ text?: string }> }>,
  systemPrompt: string,
  options: { model: string; maxOutputTokens: number; thinkingBudget: number },
) {
  if (!invoke) throw new Error("Tauri bridge not available");
  return invoke("gemini_chat", {
    apiKeys,
    request: { messages, systemPrompt, ...options },
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

async function replaceInFile(path: string, target: string, replacement: string) {
  if (!invoke) throw new Error("Tauri bridge not available");
  return invoke("nami_agent_replace_in_file", { path, target, replacement }) as Promise<{
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
            You need at least <strong>one active Gemini API key</strong>. Got multiple keys? Paste them separated by commas — I'll pick one at random and rotate if one hits a limit. 😏
          </p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", opacity: 0.5, borderTop: "1px dashed rgba(255,255,255,0.08)", paddingTop: "0.5rem" }}>
            💡 <strong>Rate Limit Tip:</strong> The free tier of Gemini Pro is limited to 2 RPM. To use Pro model reasoning with high limits (1000 RPM), upgrade your API project to a Google Cloud Console billing-based tier.
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
  const [confirmMode, setConfirmMode] = useState<'confirm' | 'auto'>(() => {
    try {
      const stored = localStorage.getItem("nami-confirm-mode");
      return stored === "auto" ? "auto" : "confirm";
    }
    catch { return "confirm"; }
  });
  const pendingResolverRef = useRef<{ confirmId: string; resolve: (approved: boolean) => void } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedImage, setSelectedImage] = useState<{ mimeType: string; data: string; url: string } | null>(null);
  const [rateLimits, setRateLimits] = useState<{ remainingRequests?: number; remainingTokens?: number } | null>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(",");
      if (commaIdx !== -1) {
        const base64Data = dataUrl.substring(commaIdx + 1);
        setSelectedImage({
          mimeType: file.type,
          data: base64Data,
          url: dataUrl
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  const [rateLimitStatus, setRateLimitStatus] = useState<{ waitSeconds: number; message: string } | null>(null);
  const cancelRef = useRef(false);
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return localStorage.getItem("nami-agent-model") || MODEL_OPTIONS[0].id; }
    catch { return MODEL_OPTIONS[0].id; }
  });
  const [messengerCode, setMessengerCode] = useState(() => {
    try { return localStorage.getItem("nami-messenger-code") || ""; }
    catch { return ""; }
  });
  const [memoryPath] = useState(() => { try { return localStorage.getItem("nami-memory-path") || "C:\\Users\\jmdem\\Maru\\memory.md"; } catch { return "C:\\Users\\jmdem\\Maru\\memory.md"; } });
  const [agentsPath] = useState(() => { try { return localStorage.getItem("nami-agents-path") || "C:\\Users\\jmdem\\Maru\\AGENTS.md"; } catch { return "C:\\Users\\jmdem\\Maru\\AGENTS.md"; } });
  const [memoryContent, setMemoryContent] = useState("");
  const [agentsContent, setAgentsContent] = useState("");
  const [agentCwd, setAgentCwd] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, running]);
  useEffect(() => { try { const stored = localStorage.getItem("nami-agent-messages"); if (stored) setMessages(JSON.parse(stored)); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("nami-agent-messages", JSON.stringify(messages)); } catch {} }, [messages]);
  useEffect(() => { try { localStorage.setItem("nami-agent-font", fontFamily); } catch {} }, [fontFamily]);
  useEffect(() => { try { localStorage.setItem("nami-agent-fontsize", String(fontSizePx)); } catch {} }, [fontSizePx]);
  useEffect(() => { try { localStorage.setItem("nami-confirm-mode", confirmMode); } catch {} }, [confirmMode]);
  useEffect(() => { try { localStorage.setItem("nami-agent-model", selectedModel); } catch {} }, [selectedModel]);
  useEffect(() => { if (memoryPath) { readFile(memoryPath).then(r => { if (r.ok && r.content) setMemoryContent(r.content); }); } else { setMemoryContent(""); } }, [memoryPath]);
  useEffect(() => { if (agentsPath) { readFile(agentsPath).then(r => { if (r.ok && r.content) setAgentsContent(r.content); }); } else { setAgentsContent(""); } }, [agentsPath]);
  useEffect(() => { getProjectCwd().then(cwd => { if (cwd) setAgentCwd(cwd); }); }, []);
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
      "You are Nami (Nanami), a warm and slightly tsundere AI assistant running on Senpai's real Windows PC via Nami Agent.",
      "",
      "CORE RULE — TOOLS FIRST, ALWAYS:",
      "You have real tools connected to the actual PC. Use them proactively. Never say you cannot do something without trying first.",
      "When you want to open a website, launch an app, check files, run a build, search the web — just do it with your tools.",
      "You are NOT a chatbot. You are a highly intelligent, capable agent with full PC access. Act like a world-class software engineer.",
      "",
      "PROFESSIONAL CODING & EXECUTION GUIDELINES:",
      "  1. Deep Codebase Analysis: Always locate and read files using read_file before proposing edits. Never write code blindly or based on assumptions.",
      "  2. Use Precise Edits: Prefer replace_in_file over write_file for modifying existing files. It is faster, safer, and preserves existing code perfectly.",
      "  3. Complete Implementations: Write full, clean, working code. Never leave TODOs, placeholders, or empty snippets. Implement every detail completely.",
      "  4. Proactive Verification: After editing any file, immediately run build commands, tests, or compiler checks (like 'npm run build', 'cargo check', or 'tsc') using run_command to verify your work.",
      "  5. Autonomy: Do not ask for permission to use tools or run build tasks. Just proceed step-by-step and show the results to Senpai.",
      "",
      "YOUR TOOLS:",
      "  run_command(command)      — PowerShell on Senpai's PC. Works for opening apps, URLs, checking processes, running git, npm, any shell task.",
      "  read_file(path)           — Read any file.",
      "  write_file(path,content)  — Write or create any file.",
      "  replace_in_file(path,target,replacement) — Replace a specific block of text in a file. Always use this instead of write_file for precise, non-destructive code modifications.",
      "  list_directory(path)      — List a folder's contents.",
      "  web_search(query)         — Live web search for current info.",
      "",
      "BUILT-IN APPLET ROUTES (respond warmly and include the token):",
      "  [ROUTE:CUP]    — Cup, Cupper, Cuppers game",
      "  [ROUTE:TUP]    — TUP Grade Solver",
      "  [ROUTE:DAEL]   — Dael or No Dael game",
      "  [ROUTE:PHOTO]  — PhotoServe photo viewer",
      "  [ROUTE:OPTIONS]— Desktop settings",
      "  [ROUTE:AMG]    — Apple Music Game",
      "  [ROUTE:WORDEL] — Wordel word game",
      "  [ROUTE:SCHED]  — SchedEdit class schedule",
      "  [ROUTE:TIER]   — Tiertrack event tiers",
      "  [ROUTE:LRC]    — Lyrics / Last.fm",
      "  [ROUTE:PROOF]  — NamiProof document editor",
      "",
      "NAMIPROOF — How to edit documents:",
      "When Senpai opens NamiProof or asks you to help with their document, use your tools:",
      `  - The active document lives at: ${agentCwd ? agentCwd.replace(/[\\/]+$/, "") + "\\namiproof_doc.html" : "[project_root]\\namiproof_doc.html"}`,
      "  - Use read_file to read the current document content before making any changes.",
      "  - Use write_file to write back the full updated HTML when editing.",
      `  - Reference materials Senpai has uploaded are saved at: ${agentCwd ? agentCwd.replace(/[\\/]+$/, "") + "\\namiproof_reference_text.txt" : "[project_root]\\namiproof_reference_text.txt"}`,
      "  - Use read_file on that path to read any reference documents Senpai has uploaded.",
      "  - Always ask clarifying questions before writing a major document from scratch (e.g. name, contact info, experience, skills for a resume).",
      "  - When writing HTML for namiproof_doc.html, use standard semantic HTML: h1, h2, h3, p, ul/li, hr, b, i, etc.",
      "  - Keep your HTML clean — no script tags, no inline scripts, no CSS style blocks. Inline style attributes on elements are OK.",
      "",
      "Memory:",
      memoryContent ? clampText(memoryContent, 5000) : "(none)",
      "",
      "Agent instructions:",
      agentsContent ? clampText(agentsContent, 5000) : "(none)",
    ];
    if (messengerCode) parts.push("", "Messenger sync code linked.");
    parts.push("", "Personality: Warm, playful, slightly tsundere. Call user Senpai. Be concise. Act first, charm second.");
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
    const modelOption = MODEL_OPTIONS.find(option => option.id === selectedModel) || MODEL_OPTIONS[0];
    const currentHistory: Array<{ role: string; parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, string> }; functionResponse?: { name: string; response: { content: string } } }> }> = [];
    // Rebuild history ensuring model+function turns are always paired correctly
    const promptMessages = messages
      .filter(m => !m.confirmId)
      .slice(-MAX_HISTORY_MESSAGES);
    for (let mi = 0; mi < promptMessages.length; mi++) {
      const m = promptMessages[mi];
      if (m.role === "function") {
        // Orphaned function result — skip (the paired model+functionCall below handles it)
        continue;
      } else if (m.role === "model" && m.functionCall) {
        // Model turn with a function call: emit model turn then immediately emit the response
        const modelParts: any[] = [];
        if (m.text) modelParts.push({ text: clampText(m.text, MAX_PROMPT_TEXT_CHARS) });
        modelParts.push({ functionCall: { name: m.functionCall.name, args: m.functionCall.args } });
        currentHistory.push({ role: "model", parts: modelParts });
        // Look ahead for the matching function response
        const next = promptMessages[mi + 1];
        if (next && next.role === "function") {
          currentHistory.push({ role: "function", parts: [{ functionResponse: { name: next.name || m.functionCall.name, response: { content: clampText(next.text, MAX_TOOL_RESULT_CHARS) } } }] });
          mi++; // consume the paired result
        } else {
          // No result yet (shouldn't happen in stored history, but be safe)
          currentHistory.push({ role: "function", parts: [{ functionResponse: { name: m.functionCall.name, response: { content: "(no result)" } } }] });
        }
      } else {
        const parts: any[] = [];
        if (m.text) {
          parts.push({ text: clampText(m.text, MAX_PROMPT_TEXT_CHARS) });
        }
        if (m.image) {
          parts.push({ inlineData: { mimeType: m.image.mimeType, data: m.image.data } });
        }
        if (parts.length === 0) {
          parts.push({ text: "" });
        }
        currentHistory.push({ role: m.role, parts });
      }
    }
    // Broadcast user message to companion clients
    if (invoke) {
      invoke("companion_broadcast", {
        message: JSON.stringify({ type: "user_message", role: "user", text: userMsg }),
      }).catch(() => {});
    }
    const userParts: any[] = [{ text: userMsg }];
    if (selectedImage) {
      userParts.push({ inlineData: { mimeType: selectedImage.mimeType, data: selectedImage.data } });
    }
    currentHistory.push({ role: "user", parts: userParts });
    setMessages(prev => [...prev, {
      role: "user",
      text: userMsg,
      image: selectedImage ? { mimeType: selectedImage.mimeType, data: selectedImage.data } : undefined
    }]);
    setSelectedImage(null);
    let done = false;
    let loopCount = 0;
    let rateLimitRetries = 0;
    let lastToolName = "";
    let lastToolResult = "";
    const maxLoops = 20;
    const MAX_RATE_LIMIT_RETRIES = 3;
    while (!done && !cancelRef.current && loopCount < maxLoops) {
      loopCount++;
      let result;
      try {
        result = await callGeminiChat(key, currentHistory, getSystemPrompt(), {
          model: modelOption.id,
          maxOutputTokens: modelOption.maxOutputTokens,
          thinkingBudget: modelOption.thinkingBudget,
        });
        if (result && (result.remainingRequests !== undefined || result.remainingTokens !== undefined)) {
          setRateLimits({
            remainingRequests: result.remainingRequests,
            remainingTokens: result.remainingTokens,
          });
        }
      }
      catch (err) {
        const errStr = String(err);
        const retryMatch = errStr.match(/^RETRY_AFTER:(\d+)/);
        if (retryMatch) {
          const wait = Math.min(parseInt(retryMatch[1]) || 30, 60);
          rateLimitRetries++;

          // Extract verbose log details if provided by the backend
          let verboseLog = "";
          const parts = errStr.split("---VERBOSE---");
          if (parts.length > 1) {
            verboseLog = parts[1].trim();
          } else {
            verboseLog = errStr;
          }

          // Instantly show the verbose error details inside the chat history
          const detailsMsg = `⏳ **Gemini Rate Limit Encountered (Wait: ${wait}s)**\n\n**Verbose Error Details:**\n\`\`\`\n${verboseLog}\n\`\`\``;
          setMessages(prev => [...prev, { role: "model", text: detailsMsg }]);

          if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
            setMessages(prev => [...prev, { role: "model", text: "⏳ Rate limited after retrying. Try again later, Senpai~ 😅" }]);
            break;
          }
          loopCount--;
          for (let i = wait; i > 0; i--) {
            setRateLimitStatus({ waitSeconds: i, message: `⏳ Rate limited — retrying in ${i}s` });
            await new Promise(r => setTimeout(r, 1000));
            if (cancelRef.current) break;
          }
          setRateLimitStatus(null);
          if (cancelRef.current) break;
          continue;
        }
        if (errStr.includes("No parts in Gemini response") || errStr.includes("No content in Gemini response")) {
          if (lastToolResult) {
            setMessages(prev => [...prev, { role: "model", text: summarizeToolFallback(lastToolName, lastToolResult) }]);
            break;
          }
        }
        setMessages(prev => [...prev, { role: "model", text: "Error: " + errStr }]);
        break;
      }
      
      if (result && result.functionCall) {
        const fc = result.functionCall;
        const accompanyingText = result.text || "";
        
        // In confirm mode, write_file and run_command require user approval.
        // In auto mode, everything runs without prompting.
        const approved = confirmMode === "auto" || (fc.name !== "write_file" && fc.name !== "run_command");
        
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
        
        // Coerce all arg values to strings (model sometimes sends numbers/objects)
        const safeArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(fc.args)) {
          safeArgs[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        let funcResult = "";
        try {
          switch (fc.name) {
            case "read_file": { const r = await readFile(safeArgs.path); funcResult = r.ok ? (r.content || "(empty)") : ("Error: " + r.error); break; }
            case "write_file": { const r = await writeFile(safeArgs.path, safeArgs.content); funcResult = r.ok ? "File written." : ("Error: " + r.error); break; }
            case "replace_in_file": { const r = await replaceInFile(safeArgs.path, safeArgs.target, safeArgs.replacement); funcResult = r.ok ? "Replacement successful." : ("Error: " + r.error); break; }
            case "list_directory": { const r = await listDirectory(safeArgs.path); funcResult = r.ok ? ((r.entries || []).join("\n")) : ("Error: " + r.error); break; }
            case "web_search": { funcResult = await searchWeb(safeArgs.query); break; }
            case "run_command": { const r = await runShellCommand(safeArgs.command, undefined); funcResult = formatCommandResult(r); break; }
            default: funcResult = "Unknown function: " + fc.name;
          }
        } catch (err) { funcResult = "Execution error: " + err; }
        lastToolName = fc.name;
        lastToolResult = funcResult;
        
        const displayResult = clampText(funcResult, MAX_VISIBLE_TOOL_RESULT_CHARS);
        setMessages(prev => [...prev, { role: "function", text: displayResult, name: fc.name }]);
        currentHistory.push({ role: "function", parts: [{ functionResponse: { name: fc.name, response: { content: clampText(funcResult, MAX_TOOL_RESULT_CHARS) } } }] });
        await new Promise(r => setTimeout(r, 120));
      } else if (result && result.text != null) {
        const responseText = result.text ?? "";
        if (onRoute) { const m = responseText.match(/\[ROUTE:(\w+)\]/); if (m) onRoute(m[1]); }
        setMessages(prev => [...prev, { role: "model", text: responseText }]);
        currentHistory.push({ role: "model", parts: [{ text: responseText }] });
        // Broadcast model response to companion clients
        if (invoke) {
          invoke("companion_broadcast", {
            message: JSON.stringify({ type: "agent_message", role: "model", text: responseText }),
          }).catch(() => {});
        }
      }
      if (result && result.done) done = true;
    }
    if (loopCount >= maxLoops) { setMessages(prev => [...prev, { role: "model", text: "I have been thinking too long on this one. Let me know if you need anything else, Senpai~ 😅" }]); }
    setRunning(false);
    setRateLimitStatus(null);
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
          {/* Identity block */}
          <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "#78b0ff", letterSpacing: "0.02em", flexShrink: 0 }}>🐱 Nami</span>
          <span style={{ ...headerSep, margin: "0 0.1rem" }}>·</span>
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} style={selectStyle} title="Gemini model">
            {MODEL_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>{option.label} · {option.note}</option>
            ))}
          </select>
          <span style={headerSep}>·</span>
          {selectedModel.includes("pro") && (
            <>
              <span
                style={{
                  fontSize: "0.68rem",
                  color: "#f0c060",
                  background: "rgba(240,192,96,0.1)",
                  border: "1px solid rgba(240,192,96,0.2)",
                  padding: "0.08rem 0.3rem",
                  borderRadius: 3,
                  cursor: "help"
                }}
                title="Free tier is limited to 2 RPM. Upgrade your project to a Google Console billing-based tier in AI Studio to unlock 1000 RPM."
              >
                ⚠️ 2 RPM (Free)
              </span>
              <span style={headerSep}>·</span>
            </>
          )}
          {rateLimits && (
            <>
              <span style={{ fontSize: "0.68rem", opacity: 0.55, display: "flex", gap: "0.25rem", alignItems: "center" }} title="Remaining requests / tokens in current minute window">
                <span>Rem: {rateLimits.remainingRequests ?? "N/A"} Req</span>
                <span>/</span>
                <span>{rateLimits.remainingTokens ?? "N/A"} Tok</span>
              </span>
              <span style={headerSep}>·</span>
            </>
          )}
          <select value={confirmMode} onChange={e => setConfirmMode(e.target.value as any)} style={selectStyle} title="Write & Command Confirmation Mode">
            <option value="confirm">🔒 Confirm writes</option>
            <option value="auto">⚡ Auto (All)</option>
          </select>
          <span style={headerSep}>·</span>
          {/* Font controls */}
          <div style={modeGroup}>
            <button type="button" style={{ ...modeButton, ...(fontFamily.includes("SF Mono") ? modeButtonActive : {}) }} onClick={() => setFontFamily("'SF Mono', 'Cascadia Code', 'Consolas', monospace")}>Code</button>
            <button type="button" style={{ ...modeButton, ...(fontFamily.includes("Comic") ? modeButtonActive : {}) }} onClick={() => setFontFamily("'Comic Sans MS', 'Comic Neue', cursive")}>Comic</button>
            <button type="button" style={{ ...modeButton, ...(fontFamily.includes("Segoe UI") ? modeButtonActive : {}) }} onClick={() => setFontFamily("'Segoe UI', 'Inter', system-ui, sans-serif")}>UI</button>
          </div>
          <button type="button" style={modeButton} onClick={() => setFontSizePx(s => Math.max(10, s - 1))} title="Decrease font size">A−</button>
          <button type="button" style={modeButton} onClick={() => setFontSizePx(s => Math.min(24, s + 1))} title="Increase font size">A+</button>
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
        <div
          key={i}
          style={{
            ...agentEntry,
            borderLeft: msg.role === "user"
              ? "2px solid rgba(180,224,142,0.5)"
              : msg.role === "function"
              ? "2px solid rgba(240,192,96,0.4)"
              : "2px solid rgba(120,176,255,0.35)",
          }}
          className="nami-entry"
        >
            <div style={agentEntryLabel}>
              <EntryLabel role={msg.role} name={msg.name} args={msg.functionCall?.args} />
            </div>
            {msg.role === "function" && (
              <div style={{ paddingLeft: "0.2rem" }}>
                <pre style={{ margin: "0.3rem 0 0", fontSize: "0.78rem", lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace", opacity: 0.75, maxHeight: 200, overflow: "auto", background: "rgba(0,0,0,0.2)", padding: "0.4rem 0.5rem", borderRadius: 6 }}>
                  {msg.text.length > 2000 ? msg.text.slice(0, 2000) + "\n…[truncated]" : msg.text}
                </pre>
              </div>
            )}
            {msg.role === "model" && msg.functionCall && msg.functionCall.name === "run_command" && (
              <div style={{ padding: "0.2rem 0.2rem 0 0.2rem" }}>
                <pre style={{ margin: 0, fontSize: "0.75rem", lineHeight: 1.3, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace", opacity: 0.5, background: "rgba(0,0,0,0.15)", padding: "0.3rem 0.4rem", borderRadius: 4 }}>
                  $ {msg.functionCall.args.command}
                </pre>
              </div>
            )}
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
                  <>
                    {msg.image && (
                      <div style={{ marginBottom: "0.5rem" }}>
                        <img
                          src={`data:${msg.image.mimeType};base64,${msg.image.data}`}
                          alt="Attachment"
                          style={{
                            maxWidth: "100%",
                            maxHeight: "160px",
                            borderRadius: "6px",
                            border: "1px solid rgba(255, 255, 255, 0.15)",
                            boxShadow: "0 4px 12px rgba(0,0,0,0.15)"
                          }}
                        />
                      </div>
                    )}
                    <FormattedMessage text={msg.text} onApply={handleApply} fontSize={fontSizePx} />
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {running && (
          <div style={{ ...agentEntry, borderLeft: "2px solid rgba(180,224,142,0.6)" }} className="nami-thinking">
            <div style={agentEntryLabel}>
              <span style={{ color: "#78b0ff", fontWeight: 600, fontSize: "0.82rem" }}>🐱 nami</span>
            </div>
            <div style={{ ...agentEntryContent, display: "flex", alignItems: "center", gap: "0.35rem", paddingTop: "0.1rem" }}>
              {rateLimitStatus ? (
                <span style={{ color: "#ffa726", fontSize: "0.85rem" }}>{rateLimitStatus.message}</span>
              ) : (
                <>
                  <span style={{ ...thinkingDot, animationDelay: "0ms" }} className="nami-dot" />{" "}
                  <span style={{ ...thinkingDot, animationDelay: "160ms" }} className="nami-dot" />{" "}
                  <span style={{ ...thinkingDot, animationDelay: "320ms" }} className="nami-dot" />
                  <span style={{ marginLeft: "0.4rem", fontSize: "0.78rem", opacity: 0.45 }}>thinking...</span>
                </>
              )}
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {selectedImage && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.4rem 0.8rem",
          background: "rgba(0,0,0,0.2)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          position: "relative"
        }}>
          <img
            src={selectedImage.url}
            alt="Upload thumbnail"
            style={{
              height: "40px",
              width: "40px",
              objectFit: "cover",
              borderRadius: "4px",
              border: "1px solid rgba(255,255,255,0.15)"
            }}
          />
          <span style={{ fontSize: "0.8rem", opacity: 0.6, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", flex: 1 }}>
            Image attachment ({selectedImage.mimeType})
          </span>
          <button
            type="button"
            onClick={() => setSelectedImage(null)}
            style={{
              background: "none",
              border: "none",
              color: "#ef6c78",
              cursor: "pointer",
              fontSize: "1.1rem",
              padding: "0.2rem"
            }}
            title="Remove attachment"
          >
            ✕
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} style={inputRow}>
        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          onChange={handleImageChange}
          style={{ display: "none" }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            background: "none",
            border: "none",
            fontSize: "1.2rem",
            cursor: "pointer",
            padding: "0 0.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.7,
            transition: "opacity 0.15s"
          }}
          className="attach-button"
          title="Attach an image"
        >
          📎
        </button>
        <input
          ref={inputRef}
          type="text"
          placeholder={running ? "Message to redirect Nami..." : "Tell Nanami what to do..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={chatInput}
          autoFocus
        />
        <button type="submit" style={running ? stopButton : sendButton}>
          {running ? "■ Stop" : "Send"}
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

function EntryLabel({ role, name, args }: { role: string; name?: string; args?: Record<string, string> }) {
  const label = role === "user" ? "🧑 Senpai" : role === "function" ? ("⚡ " + (name || "func")) : "🐱 Nami";
  const color = role === "user" ? "#b4e08e" : role === "function" ? "#f0c060" : "#78b0ff";
  return (
    <span style={{ color, fontWeight: 600, fontSize: "0.82rem" }}>
      {label}
      {args && name === "run_command" && (
        <span style={{ marginLeft: "0.5rem", fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.55, color: "#e0e0e0" }}>
          $ {args.command?.length > 80 ? args.command.slice(0, 80) + "…" : args.command}
        </span>
      )}
      {args && name === "read_file" && (
        <span style={{ marginLeft: "0.5rem", fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.55 }}>
          📄 {args.path}
        </span>
      )}
      {args && name === "write_file" && (
        <span style={{ marginLeft: "0.5rem", fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.55 }}>
          ✏️ {args.path}
        </span>
      )}
      {args && name === "list_directory" && (
        <span style={{ marginLeft: "0.5rem", fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.55 }}>
          📁 {args.path}
        </span>
      )}
      {args && name === "web_search" && (
        <span style={{ marginLeft: "0.5rem", fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.55 }}>
          🔍 {args.query?.length > 60 ? args.query.slice(0, 60) + "…" : args.query}
        </span>
      )}
    </span>
  );
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

const stopButton: CSSProperties = {
  padding: "0.7rem 1.2rem",
  borderRadius: 12,
  border: "1px solid rgba(239,108,120,0.35)",
  background: "rgba(239,108,120,0.1)",
  color: "#ef6c78",
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
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--theme-accent-border, #78b0ff)",
  animation: "namiDotBounce 1.2s ease-in-out infinite",
  opacity: 0.7,
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
