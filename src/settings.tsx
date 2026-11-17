import { useEffect, useRef, useState } from "react";
import { setRenderDark, stageColour } from "./render/theme";

export type ThemePref = "light" | "dark" | "system";
const KEY = "biosentry.theme";
const CHANGED = "biosentry:theme";
const OPTIONS: { id: ThemePref; label: string; icon: string }[] = [
  { id: "light", label: "Light", icon: "fa-sun" },
  { id: "dark", label: "Dark", icon: "fa-moon" },
  { id: "system", label: "System", icon: "fa-circle-half-stroke" },
];

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
export const resolveTheme = (pref: ThemePref): "light" | "dark" => (pref === "system" ? (systemDark() ? "dark" : "light") : pref);

/** Puts the choice on <html> (the kit reads data-hw-theme) and tells the canvas. Safe to call before React renders. */
export function applyTheme(pref: ThemePref = themePref()): "light" | "dark" {
  const t = resolveTheme(pref);
  setRenderDark(t === "dark");
  const root = document.documentElement;
  root.dataset.hwTheme = t;
  root.dataset.hwFamily = "cloud";
  root.style.setProperty("--stage", stageColour());
  return t;
}

export function saveTheme(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* the page works without storage */
  }
  applyTheme(pref);
  window.dispatchEvent(new Event(CHANGED));
}

/** The theme in force ("light" or "dark"), updated when the person chooses or the system changes under "System". */
export function useTheme(): "light" | "dark" {
  const [t, setT] = useState(() => resolveTheme(themePref()));
  useEffect(() => {
    const on = () => setT(applyTheme());
    window.addEventListener(CHANGED, on);
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener("change", on);
    return () => {
      window.removeEventListener(CHANGED, on);
      mq?.removeEventListener("change", on);
    };
  }, []);
  return t;
}

/** The gear in the app bar and the native dialog it opens. Holds the theme choice and nothing else yet. */
export function Settings() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pref, setPref] = useState(themePref);
  return (
    <>
      <button type="button" className="hw-button hw-button--sm hw-button--icon" aria-label="Settings" title="Settings" onClick={() => dialog.current?.showModal?.()}>
        <i className="hw-icon fa-solid fa-gear" aria-hidden="true" />
      </button>
      <dialog ref={dialog} className="hw-dialog hw-dialog--sm settings" aria-labelledby="settings-title" onClick={(e) => e.target === dialog.current && dialog.current.close()}>
        <div className="hw-dialog__header">
          <h2 className="hw-dialog__title" id="settings-title">Settings</h2>
          <button type="button" className="hw-close" aria-label="Close" onClick={() => dialog.current?.close()}>
            <i className="hw-icon fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
        <div className="hw-dialog__body">
          <fieldset className="settings__group">
            <legend className="hw-field__label">Theme</legend>
            {OPTIONS.map((o) => (
              <label key={o.id} className="hw-radio">
                <input className="hw-radio__input" type="radio" name="theme" value={o.id} checked={pref === o.id} onChange={() => { setPref(o.id); saveTheme(o.id); }} />
                <span className="hw-radio__dot" />
                <i className={`hw-icon fa-solid ${o.icon}`} aria-hidden="true" />
                {o.label}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="hw-dialog__footer">
          <button type="button" className="hw-button hw-button--primary" onClick={() => dialog.current?.close()}>Done</button>
        </div>
      </dialog>
    </>
  );
}
