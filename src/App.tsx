import "./index.css";

const CARS = ["🚗", "🚙", "🚕", "🚓", "🏎️"];

function FlyingCars() {
  return (
    <div className="flying-cars" aria-hidden="true">
      {Array.from({ length: 14 }).map((_, i) => {
        const emoji = CARS[i % CARS.length];
        const top = Math.random() * 100;
        const duration = 8 + Math.random() * 10;
        const delay = Math.random() * -20;
        const size = 24 + Math.random() * 32;
        const reverse = i % 2 === 0;
        return (
          <span
            key={i}
            className={`flying-car ${reverse ? "reverse" : ""}`}
            style={{
              top: `${top}vh`,
              fontSize: `${size}px`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
            }}
          >
            {emoji}
          </span>
        );
      })}
    </div>
  );
}

function App() {
  return (
    <div className="hero-page">
      <FlyingCars />
      <h1 className="hero-title">carpool crazy</h1>
    </div>
  );
}

export default App;
