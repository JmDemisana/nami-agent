import { useState, useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import NamiAgent from "./NamiAgent";
import PhotoServe from "../pages/PhotoServe";
import CupCupperCuppers from "../pages/CupCupperCuppers";
import DaelOrNoDaelSingle from "../pages/DaelOrNoDael";
import TupGradeSolver from "../pages/TupGradeSolver";
import AppleMusicGame from "../pages/AppleMusicGame";
import Wordel from "../pages/Wordel";
import ClassScheduleEditor from "../pages/ClassScheduleEditor";
import Tiertrack from "../pages/Tiertrack";
import LyricsDatabase from "../pages/LyricsDatabase";
import NamiProof from "../pages/NamiProof";
import Onu from "../pages/Onu";
import TyperShork from "../pages/TyperShork";
import CurrenC from "../pages/CurrenC";
import ArtworkFinder from "../pages/ArtworkFinder";
import NanamiLorebook from "../pages/NanamiLorebook";
import KhenAcademy from "../pages/KhenAcademy";
import AniList from "../pages/AniList";
import DesktopOptions from "./DesktopOptions";
import UpdateChecker from "./UpdateChecker";
import "../index.css";
import "../App.css";
import "./desktop.css";
import { applyDesktopAppearance } from "./settings";

type AppletId = "cup-cupper-cuppers" | "dael-or-no-dael" | "tup-grade-solver" | "photo-serve" | "options" | "apple-music-game" | "wordel" | "class-schedule-editor" | "tiertrack" | "lyrics-database" | "namiproof" | "onu" | "typer-shork" | "currenc" | "artwork-finder" | "nanami-lorebook" | "khenacademy" | "anilist" | null;

const APPLET_ROUTE_MAP: Record<string, AppletId> = {
  CUP: "cup-cupper-cuppers",
  TUP: "tup-grade-solver",
  DAEL: "dael-or-no-dael",
  PHOTO: "photo-serve",
  OPTIONS: "options",
  AMG: "apple-music-game",
  WORDEL: "wordel",
  SCHED: "class-schedule-editor",
  TIER: "tiertrack",
  LRC: "lyrics-database",
  PROOF: "namiproof",
  ONU: "onu",
  TYPER: "typer-shork",
  CURRENC: "currenc",
  ART: "artwork-finder",
  LORE: "nanami-lorebook",
  KHEN: "khenacademy",
  ANILIST: "anilist",
  HOME: null as any,
};

const APPLET_COMPONENTS: Record<string, React.FC> = {
  "cup-cupper-cuppers": CupCupperCuppers,
  "dael-or-no-dael": DaelOrNoDaelSingle,
  "tup-grade-solver": TupGradeSolver,
  "photo-serve": PhotoServe,
  "options": DesktopOptions,
  "apple-music-game": AppleMusicGame,
  "wordel": Wordel,
  "class-schedule-editor": ClassScheduleEditor,
  "tiertrack": Tiertrack,
  "lyrics-database": LyricsDatabase,
  "namiproof": NamiProof,
  "onu": Onu,
  "typer-shork": TyperShork,
  "currenc": CurrenC,
  "artwork-finder": ArtworkFinder,
  "nanami-lorebook": NanamiLorebook,
  "khenacademy": KhenAcademy,
  "anilist": AniList,
};

const NEEDS_ROUTER = new Set(["apple-music-game", "wordel", "lyrics-database", "onu", "typer-shork", "nanami-lorebook", "khenacademy", "anilist"]);

function AppletContent({ applet }: { applet: string }) {
  const Component = APPLET_COMPONENTS[applet];
  if (!Component) return <div style={{ padding: "2rem", opacity: 0.5 }}>Unknown applet: {applet}</div>;
  if (NEEDS_ROUTER.has(applet)) return <MemoryRouter><Component /></MemoryRouter>;
  return <Component />;
}

function NamiShell() {
  const [activeApplet, setActiveApplet] = useState<AppletId>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("left");
  const [showSidebarSettings, setShowSidebarSettings] = useState(false);
  const resizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleRoute = useCallback((routeTag: string) => {
    const id = APPLET_ROUTE_MAP[routeTag];
    if (id === undefined) return;
    setActiveApplet(id);
  }, []);

  const handleCloseApplet = useCallback(() => {
    setActiveApplet(null);
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    startX.current = e.clientX;
    startWidth.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = sidebarSide === "left" ? ev.clientX - startX.current : startX.current - ev.clientX;
      setSidebarWidth(Math.max(200, Math.min(500, startWidth.current + delta)));
    };
    const onUp = () => {
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth, sidebarSide]);

  const applet = activeApplet;

  const sidebarStyle: React.CSSProperties = applet ? {
    width: sidebarWidth,
    minWidth: 200,
    maxWidth: 500,
    borderRight: sidebarSide === "left" ? "1px solid rgba(255,255,255,0.06)" : "none",
    borderLeft: sidebarSide === "right" ? "1px solid rgba(255,255,255,0.06)" : "none",
    display: "flex",
    flexDirection: "column",
    position: "relative",
  } : {
    width: "100%",
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: sidebarSide === "right" && applet ? "row-reverse" : "row" }}>
      <div style={sidebarStyle}>
        <NamiAgent onRoute={handleRoute} compact={!!applet} hideTitlebar={!!applet} />
        {applet && (
          <div
            onMouseDown={handleResizeStart}
            style={{
              position: "absolute",
              top: 0,
              [sidebarSide === "left" ? "right" : "left"]: -3,
              width: 6,
              height: "100%",
              cursor: "col-resize",
              zIndex: 10,
            }}
          />
        )}
      </div>
      {applet && (
        <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: "0.5rem",
            padding: "0.3rem 1rem",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background: "var(--theme-panel-bg, rgba(10,18,34,0.72))",
            fontSize: "0.82rem", flexShrink: 0,
          }}>
            <button
              type="button"
              onClick={handleCloseApplet}
              style={{
                padding: "0.15rem 0.5rem", borderRadius: 4,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "transparent", color: "var(--theme-text-strong, #f2f6ff)",
                fontSize: "0.72rem", cursor: "pointer", opacity: 0.5, whiteSpace: "nowrap",
              }}
            >
              ← Back to Nami
            </button>
            <span style={{ fontSize: "0.72rem", opacity: 0.4 }}>{applet.replace(/-/g, " ")}</span>
            <button
              type="button"
              onClick={() => setShowSidebarSettings(!showSidebarSettings)}
              style={{
                marginLeft: "auto", padding: "0.15rem 0.4rem", borderRadius: 3,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "transparent", color: "var(--theme-text-strong, #f2f6ff)",
                fontSize: "0.68rem", cursor: "pointer", opacity: 0.4,
              }}
            >
              ⚙
            </button>
          </div>
          {showSidebarSettings && (
            <div style={{
              padding: "0.5rem 1rem", borderBottom: "1px solid rgba(255,255,255,0.06)",
              background: "rgba(0,0,0,0.2)", fontSize: "0.78rem", display: "flex", gap: "1rem", alignItems: "center", flexShrink: 0,
            }}>
              <span style={{ opacity: 0.5 }}>Sidebar:</span>
              <button type="button" onClick={() => setSidebarSide("left")} style={{ opacity: sidebarSide === "left" ? 1 : 0.4, cursor: "pointer", background: "none", border: "none", color: "inherit" }}>Left</button>
              <button type="button" onClick={() => setSidebarSide("right")} style={{ opacity: sidebarSide === "right" ? 1 : 0.4, cursor: "pointer", background: "none", border: "none", color: "inherit" }}>Right</button>
              <span style={{ opacity: 0.5, marginLeft: "auto" }}>{sidebarWidth}px</span>
              <input
                type="range" min="200" max="500"
                value={sidebarWidth}
                onChange={(e) => setSidebarWidth(Number(e.target.value))}
                style={{ width: 80, opacity: 0.5 }}
              />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <AppletContent applet={applet} />
          </div>
        </div>
      )}
      <UpdateChecker />
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  applyDesktopAppearance();
  const root = createRoot(container);
  root.render(<NamiShell />);
}
