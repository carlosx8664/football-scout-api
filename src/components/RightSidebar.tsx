import { useEffect, useRef, useState } from "react";
import "./RightSidebar.css";

const TIPSTERS = [
  { name: "Andy Robson", url: "https://x.com/AndyRobsonTips" },
  { name: "The Betting Village", url: "https://x.com/bettingvillage" },
  { name: "Gary Doc", url: "https://x.com/garydoc777" },
  { name: "Sjakktrekk", url: "https://x.com/Sjakktrekk" },
  { name: "King Tipster", url: "https://x.com/The_KingTipster" },
];

declare global {
  interface Window {
    twttr?: {
      widgets?: {
        load: (element?: HTMLElement | null) => void;
      };
    };
  }
}

const RightSidebar = () => {
  const [selectedUrl, setSelectedUrl] = useState(TIPSTERS[0].url);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const script = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.x.com/widgets.js"]',
    );
    const loadTimeline = () => window.twttr?.widgets?.load(timelineRef.current);

    if (window.twttr?.widgets) {
      loadTimeline();
      return;
    }

    script?.addEventListener("load", loadTimeline);

    return () => script?.removeEventListener("load", loadTimeline);
  }, [selectedUrl]);

  return (
    <aside className="right-sidebar">
      <section className="tipsters-container">
        <h3>Latest from Tipsters</h3>
        <label className="tipster-select-label" htmlFor="tipster-select">
          Choose a tipster
        </label>
        <select
          id="tipster-select"
          className="tipster-select"
          value={selectedUrl}
          onChange={(event) => setSelectedUrl(event.target.value)}
        >
          {TIPSTERS.map((tipster) => (
            <option key={tipster.url} value={tipster.url}>
              {tipster.name}
            </option>
          ))}
        </select>
        <div className="twitter-timeline-container" ref={timelineRef}>
          <a
            key={selectedUrl}
            className="twitter-timeline"
            href={selectedUrl}
            data-tweet-limit="3"
            data-chrome="nofooter noborders transparent"
            data-theme="light"
          >
            Tweets by {TIPSTERS.find((tipster) => tipster.url === selectedUrl)?.name}
          </a>
        </div>
      </section>
    </aside>
  );
};

export default RightSidebar;