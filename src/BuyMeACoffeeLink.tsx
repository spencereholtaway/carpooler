export function BuyMeACoffeeLink({ className }: { className?: string }) {
  return (
    <a
      href="https://www.buymeacoffee.com/holtaway"
      target="_blank"
      rel="noopener noreferrer"
      className={className ? `coffee-link ${className}` : "coffee-link"}
    >
      <img
        src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee?&emoji=☕&slug=holtaway&button_colour=BD5FFF&font_colour=ffffff&font_family=Bree&outline_colour=000000&coffee_colour=FFDD00"
        alt="Buy me a coffee"
      />
    </a>
  );
}
