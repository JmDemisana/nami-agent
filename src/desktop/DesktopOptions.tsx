import { useEffect, useState, type CSSProperties } from "react";
import {
  applyDesktopAppearance,
  readDesktopAppOptions,
  resetDesktopAppOptions,
  saveDesktopAppOptions,
  type DesktopAppOptions,
  type DesktopVisualStyle,
} from "./settings";

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "fil", label: "Filipino" },
] as const;

const THEME_OPTIONS: Array<{
  value: DesktopVisualStyle;
  label: string;
  copy: string;
}> = [
  {
    value: "it_started_here",
    label: "It Started Here",
    copy: "The current Nami look.",
  },
  {
    value: "quiet_tide",
    label: "Quiet Tide",
    copy: "Calm blue glassy theme.",
  },
  {
    value: "amoled",
    label: "AMOLED",
    copy: "Deep black, crisp contrast.",
  },
  {
    value: "dark_corporate",
    label: "Dark Corporate",
    copy: "Clean familiar dark mode.",
  },
  {
    value: "urple",
    label: "Urple",
    copy: "Playful purple energy.",
  },
  {
    value: "random_refresh",
    label: "Random Theme Every Refresh",
    copy: "Chaos, but intentional.",
  },
] as const;

export default function DesktopOptions() {
  const [options, setOptions] = useState<DesktopAppOptions>(() =>
    readDesktopAppOptions(),
  );

  useEffect(() => {
    applyDesktopAppearance(options);
  }, [options]);

  useEffect(() => {
    const syncOptions = () => {
      setOptions(readDesktopAppOptions());
    };

    window.addEventListener("app-options-change", syncOptions);
    return () => {
      window.removeEventListener("app-options-change", syncOptions);
    };
  }, []);

  const updateOptions = (partial: Partial<DesktopAppOptions>) => {
    const next = {
      ...options,
      ...partial,
    };
    setOptions(next);
    saveDesktopAppOptions(partial);
  };

  return (
    <div className="desktop-settings-page">
      <section className="options-hero-card desktop-options-hero">
        <h1 style={{ margin: 0, fontSize: "clamp(1.5rem, 3vw, 2rem)" }}>
          Options
        </h1>
        <p style={{ margin: "0.6rem 0 0", opacity: 0.72, lineHeight: 1.6 }}>
          Desktop-only settings that still matter for the local app.
        </p>
      </section>

      <div className="options-desktop-columns desktop-options-columns">
        <div className="options-column">
          <section className="acrylic-card desktop-options-card">
            <h2 style={cardTitleStyle}>Language</h2>
            <p style={bodyCopyStyle}>
              Keep the shared site language in sync for desktop applets too.
            </p>
            <div style={buttonRowStyle}>
              {LANGUAGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`desktop-toggle-button${
                    options.lang === option.value ? " is-active" : ""
                  }`}
                  onClick={() => updateOptions({ lang: option.value })}
                  disabled={options.lang === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="acrylic-card desktop-options-card">
            <h2 style={cardTitleStyle}>Card Hover Nudge</h2>
            <p style={bodyCopyStyle}>
              Stop launcher cards from lifting when hovered.
            </p>
            <div style={buttonRowStyle}>
              <button
                type="button"
                className={`desktop-toggle-button${
                  !options.disableCardHoverNudge ? " is-active" : ""
                }`}
                onClick={() => updateOptions({ disableCardHoverNudge: false })}
                disabled={!options.disableCardHoverNudge}
              >
                Enable
              </button>
              <button
                type="button"
                className={`desktop-toggle-button${
                  options.disableCardHoverNudge ? " is-active" : ""
                }`}
                onClick={() => updateOptions({ disableCardHoverNudge: true })}
                disabled={options.disableCardHoverNudge}
              >
                Disable
              </button>
            </div>
          </section>
        </div>

        <div className="options-column">
          <section className="acrylic-card desktop-options-card">
            <h2 style={cardTitleStyle}>Themes</h2>
            <p style={bodyCopyStyle}>
              Same theme choices as the site, but focused on the desktop app.
            </p>
            <div className="visual-style-grid">
              {THEME_OPTIONS.map((theme) => (
                <button
                  key={theme.value}
                  type="button"
                  className={`visual-style-option${
                    options.visualStyle === theme.value ? " active" : ""
                  }`}
                  data-style-preview={theme.value}
                  onClick={() => updateOptions({ visualStyle: theme.value })}
                  disabled={options.visualStyle === theme.value}
                >
                  <span className="visual-style-label">{theme.label}</span>
                  <span className="visual-style-copy">{theme.copy}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="acrylic-card desktop-options-card">
            <h2 style={cardTitleStyle}>Reset</h2>
            <p style={bodyCopyStyle}>
              Reset the desktop app appearance and language options.
            </p>
            <div style={buttonRowStyle}>
              <button
                type="button"
                className="portal-btn"
                style={resetButtonStyle}
                onClick={() => {
                  resetDesktopAppOptions();
                  setOptions(readDesktopAppOptions());
                }}
              >
                Reset Desktop Options
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const cardTitleStyle: CSSProperties = {
  marginTop: 0,
  fontSize: "1.05rem",
};

const bodyCopyStyle: CSSProperties = {
  marginTop: 0,
  opacity: 0.72,
  lineHeight: 1.6,
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.7rem",
};

const resetButtonStyle: CSSProperties = {
  padding: "0.8rem 1rem",
  borderRadius: "12px",
  width: "100%",
};
