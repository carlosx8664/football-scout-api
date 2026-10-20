import "./Header.css";

const Header = () => {
  return (
    <header className="top-header">
      <div className="header-inner">
        <div className="header-left">
          <a className="logo" href="/">
            ABC
          </a>
          <nav className="top-nav">
            <a href="#">Tip Hub</a>
            <a href="#">Champions League</a>
            <a href="#">Football ▾</a>
            <a href="#">Best Bookies</a>
          </nav>
        </div>
        <div className="header-right">
          <button className="btn-signup">🎁 Free Bets</button>
          <button className="btn-login">Log in</button>
        </div>
      </div>
    </header>
  );
};

export default Header;
