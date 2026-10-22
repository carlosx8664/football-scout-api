import "./RightSidebar.css";

const RightSidebar = () => {
  return (
    <aside className="right-sidebar">
      <section className="tipsters-container">
        <h3>Latest from Tipsters</h3>
        <div className="twitter-timeline-container">
          <a
            className="twitter-timeline"
            href="https://x.com/i/lists/1115207864979808257?s=20"
            data-tweet-limit="3"
            data-chrome="nofooter noborders transparent"
          >
            Latest from Tipsters
          </a>
        </div>
      </section>
    </aside>
  );
};

export default RightSidebar;