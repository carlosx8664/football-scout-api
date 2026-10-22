import "./Header.css";

const Header = () => {
  return (
    <header className="top-header">
      <div className="header-inner">
        <div className="header-left">
          <a className="logo" href="/">
            <img
              src="/logo.png"
              alt="Oddtor"
              style={{
                height: "40px",
                width: "auto",
                maxWidth: "150px",
                objectFit: "contain",
                cursor: "pointer",
              }}
            />
          </a>
          <nav className="top-nav">
            <a href="#">Tip Hub</a>
          </nav>
        </div>
        <div className="header-right">
          <button className="btn-login">Log in</button>
        </div>
      </div>
    </header>
  );
};

export default Header;
