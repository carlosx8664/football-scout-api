import { useEffect, useState } from "react";
import "./InstallPrompt.css";

/** Chrome/Edge fire this instead of showing the native mini-infobar. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (window.navigator as { standalone?: boolean }).standalone === true;

const InstallPrompt = () => {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Keep the event so "Add to Home Screen" can be triggered by our own button.
      event.preventDefault();
      if (isStandalone()) return;
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!promptEvent) return null;

  const install = async () => {
    await promptEvent.prompt();
    await promptEvent.userChoice;
    // The event is single-use: a new one is only fired after a fresh page load.
    setPromptEvent(null);
  };

  return (
    <button type="button" className="install-prompt" onClick={install}>
      Add to Home Screen
    </button>
  );
};

export default InstallPrompt;
