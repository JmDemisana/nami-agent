import { useState, useEffect } from "react";

const CURRENT_VERSION = "0.0.9";
const REPO = "JmDemisana/maru-desktop";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

interface UpdateInfo {
  tag: string;
  name: string;
  url: string;
  body: string;
}

export default function UpdateChecker() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const dismissedKey = `update-dismissed-${CURRENT_VERSION}`;
    if (sessionStorage.getItem(dismissedKey)) {
      setDismissed(true);
      return;
    }

    let cancelled = false;
    fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const tag: string = data.tag_name ?? "";
        if (tag && semverGt(tag, CURRENT_VERSION)) {
          setUpdate({
            tag,
            name: data.name ?? tag,
            url: data.html_url ?? RELEASES_PAGE,
            body: (data.body ?? "").trim(),
          });
        }
      })
      .catch(() => {
        /* silently ignore network errors */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!update || dismissed) return null;

  const handleDismiss = () => {
    sessionStorage.setItem(`update-dismissed-${CURRENT_VERSION}`, "1");
    setDismissed(true);
  };

  const shortBody = update.body.split("\n").slice(0, 3).join("\n");

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        right: "1rem",
        zIndex: 9999,
        width: 320,
        borderRadius: 12,
        border: "1px solid rgba(130, 200, 255, 0.25)",
        background:
          "linear-gradient(135deg, rgba(10,20,40,0.97) 0%, rgba(15,28,58,0.97) 100%)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(130,200,255,0.08) inset",
        backdropFilter: "blur(12px)",
        animation: "updateSlideIn 0.35s cubic-bezier(0.34,1.56,0.64,1) both",
        overflow: "hidden",
        fontFamily: "inherit",
      }}
    >
      <style>{`
        @keyframes updateSlideIn {
          from { opacity: 0; transform: translateY(20px) scale(0.95); }
          to   { opacity: 1; transform: translateY(0)  scale(1); }
        }
        .upd-btn {
          cursor: pointer;
          background: none;
          border: none;
          font-family: inherit;
          transition: opacity 0.15s;
        }
        .upd-btn:hover { opacity: 0.75; }
        .upd-notes {
          font-size: 0.72rem;
          line-height: 1.5;
          color: rgba(200,220,255,0.65);
          white-space: pre-wrap;
          margin-top: 0.4rem;
          padding-top: 0.4rem;
          border-top: 1px solid rgba(255,255,255,0.06);
          max-height: 120px;
          overflow-y: auto;
        }
        .upd-notes::-webkit-scrollbar { width: 3px; }
        .upd-notes::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
      `}</style>

      {/* Top accent bar */}
      <div
        style={{
          height: 3,
          background:
            "linear-gradient(90deg, #4fc3f7 0%, #7c4dff 60%, #4fc3f7 100%)",
          backgroundSize: "200% 100%",
          animation: "none",
        }}
      />

      <div style={{ padding: "0.85rem 1rem" }}>
        {/* Header row */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5rem",
          }}
        >
          <span style={{ fontSize: "1.1rem", lineHeight: 1, flexShrink: 0 }}>
            🚀
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "#a8d8ff",
                letterSpacing: "0.02em",
              }}
            >
              Update Available
            </div>
            <div
              style={{
                fontSize: "0.7rem",
                color: "rgba(180,210,255,0.5)",
                marginTop: 2,
              }}
            >
              {CURRENT_VERSION} → <strong style={{ color: "#7dd3fc" }}>{update.tag}</strong>
            </div>
          </div>
          <button
            className="upd-btn"
            onClick={handleDismiss}
            title="Dismiss"
            style={{
              fontSize: "0.85rem",
              color: "rgba(255,255,255,0.3)",
              padding: "0 0.2rem",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Release name */}
        {update.name !== update.tag && (
          <div
            style={{
              fontSize: "0.73rem",
              color: "rgba(200,220,255,0.7)",
              marginTop: "0.35rem",
              fontStyle: "italic",
            }}
          >
            {update.name}
          </div>
        )}

        {/* Release notes toggle */}
        {update.body && (
          <>
            <button
              className="upd-btn"
              onClick={() => setExpanded((e) => !e)}
              style={{
                marginTop: "0.45rem",
                fontSize: "0.68rem",
                color: "rgba(130,200,255,0.55)",
                padding: 0,
              }}
            >
              {expanded ? "▲ Hide notes" : "▼ What's new"}
            </button>
            {expanded && (
              <div className="upd-notes">
                {shortBody}
                {update.body.split("\n").length > 3 && (
                  <span style={{ opacity: 0.5 }}>{"\n"}...</span>
                )}
              </div>
            )}
          </>
        )}

        {/* CTA row */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "0.7rem",
            alignItems: "center",
          }}
        >
          <a
            href={update.url}
            target="_blank"
            rel="noreferrer"
            style={{
              flex: 1,
              textAlign: "center",
              padding: "0.35rem 0.75rem",
              borderRadius: 7,
              background:
                "linear-gradient(135deg, #1e4fa0 0%, #2d2a8a 100%)",
              border: "1px solid rgba(130,200,255,0.2)",
              color: "#b8d8ff",
              fontSize: "0.73rem",
              fontWeight: 600,
              textDecoration: "none",
              transition: "filter 0.15s",
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLElement).style.filter = "brightness(1.2)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.filter = "")
            }
          >
            View Release
          </a>
          <button
            className="upd-btn"
            onClick={handleDismiss}
            style={{
              padding: "0.35rem 0.6rem",
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,0.07)",
              color: "rgba(180,200,255,0.4)",
              fontSize: "0.68rem",
            }}
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
