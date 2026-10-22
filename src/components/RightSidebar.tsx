import { useEffect, useRef, useState } from "react";
import "./RightSidebar.css";

const TIPSTERS = [
  { name: "Andy Robson", handle: "AndyRobsonTips" },
  { name: "The Betting Village", handle: "bettingvillage" },
  { name: "Gary Doc", handle: "garydoc777" },
  { name: "Sjakktrekk", handle: "Sjakktrekk" },
  { name: "King Tipster", handle: "The_KingTipster" },
];

declare global {
  interface Window {
    twttr?: {
      widgets?: {
        createTimeline: (
          source: { sourceType: "profile"; screenName: string },
          target: HTMLElement,
          options: { height: number; chrome: string; tweetLimit: number },
        ) => Promise<HTMLElement>;
      };
    };
  }
}

const RightSidebar = () => {
  const [selectedHandle, setSelectedHandle] = useState(TIPSTERS[0].handle);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let attempts = 0;
    let interval: number | null = null;
    const container = timelineRef.current;

    if (!container) return;
    container.innerHTML = "";

    const renderTimeline = () => {
      if (!active) return;
      const widgets = window.twttr?.widgets;

      if (widgets?.createTimeline) {
        if (interval !== null) window.clearInterval(interval);
        void widgets
          .createTimeline(
            { sourceType: "profile", screenName: selectedHandle },
            container,
            {
              height: 400,
              chrome: "nofooter noborders transparent",
              tweetLimit: 3,
            },
          )
          .catch((error: unknown) => {
            if (active) console.error("Failed to render X timeline:", error);
          });
        return;
      }

      attempts += 1;
      if (attempts >= 50) {
        if (interval !== null) window.clearInterval(interval);
        console.error("X widgets did not become ready; timeline could not be rendered.");
      }
    };

    interval = window.setInterval(renderTimeline, 100);
    renderTimeline();

    return () => {
      active = false;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [selectedHandle]);

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
          value={selectedHandle}
          onChange={(event) => setSelectedHandle(event.target.value)}
        >
          {TIPSTERS.map((tipster) => (
            <option key={tipster.handle} value={tipster.handle}>
              {tipster.name}
            </option>
          ))}
        </select>
        <div
          key={selectedHandle}
          className="twitter-timeline-container"
          ref={timelineRef}
        />
      </section>
    </aside>
  );
};

export default RightSidebar;