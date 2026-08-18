export function KidPicker({
  allKids,
  selected,
  onChange,
  label = "Which of your kids are in this carpool?",
}: {
  allKids: string[];
  selected: string[];
  onChange: (kids: string[]) => void;
  label?: string;
}) {
  if (allKids.length === 0) return null;

  const toggle = (kid: string) => {
    onChange(selected.includes(kid) ? selected.filter((k) => k !== kid) : [...selected, kid]);
  };

  return (
    <div className="gate-field">
      <span className="gate-field-label">{label}</span>
      <div className="kid-tags">
        {allKids.map((kid) => {
          const active = selected.includes(kid);
          return (
            <button
              type="button"
              key={kid}
              className={`kid-pick ${active ? "active" : ""}`}
              onClick={() => toggle(kid)}
              aria-pressed={active}
            >
              {kid}
            </button>
          );
        })}
      </div>
    </div>
  );
}
