import { useTheme } from "../lib/theme";
import "./ThemeToggle.css";

/** Light/dark switch that sits beside the simulation toggle in the header. */
const ThemeToggle = () => {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Toggle dark mode"
      className={`theme-toggle ${dark ? "on" : "off"}`}
      onClick={toggle}
      title={dark ? "Dark mode is on — switch to light" : "Light mode — switch to dark"}
    >
      <span className="theme-toggle-track" aria-hidden="true">
        <span className="theme-toggle-thumb" />
      </span>
      <span className="theme-toggle-label">Dark</span>
    </button>
  );
};

export default ThemeToggle;
