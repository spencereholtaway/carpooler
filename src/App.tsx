import "./index.css";

// Apple's set draws these nose-left, except the race car which is nose-right;
// flip that one so every car visually faces the direction it's driving.
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
            className="flying-car"
            style={{
              top: `${top}vh`,
              fontSize: `clamp(${size * 0.6}px, ${size / 10}vw, ${size}px)`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
            }}
          >
            <span className={car.facing === "right" ? "flip" : ""}>
              {car.emoji}
            </span>
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
