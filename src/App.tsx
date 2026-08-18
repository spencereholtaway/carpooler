import "./index.css";

// Each emoji has a fixed drawn facing direction (Apple's set draws these
// nose-left, race car nose-right) - cars only ever drive that way.
const CARS: { emoji: string; facing: "left" | "right" }[] = [
  { emoji: "🚗", facing: "left" },
  { emoji: "🚙", facing: "left" },
  { emoji: "🚕", facing: "left" },
  { emoji: "🚓", facing: "left" },
  { emoji: "🏎️", facing: "right" },
];

function FlyingCars() {
  return (
    <div className="flying-cars" aria-hidden="true">
      {Array.from({ length: 14 }).map((_, i) => {
        const car = CARS[i % CARS.length];
        const top = Math.random() * 100;
        const duration = 10 + Math.random() * 10;
        const delay = Math.random() * -20;
        const size = 20 + Math.random() * 24;
        return (
          <span
            key={i}
            className={`flying-car ${car.facing === "left" ? "drives-left" : "drives-right"}`}
            style={{
              top: `${top}vh`,
              fontSize: `clamp(${size * 0.6}px, ${size / 10}vw, ${size}px)`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
            }}
          >
            {car.emoji}
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
