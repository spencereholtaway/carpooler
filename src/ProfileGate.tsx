import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { claimName, getServerProfile, linkHousehold } from "./api";
import type { LocalProfile } from "./useProfile";

export function ProfileGate({
  memberId,
  onSubmit,
  onRecoverMemberId,
}: {
  memberId: string;
  onSubmit: (profile: LocalProfile) => void;
  onRecoverMemberId: (id: string) => void;
}) {
  const [step, setStep] = useState<0 | 1 | "coparent" | 2>(0);
  const [name, setName] = useState("");
  const [checkingName, setCheckingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);

  const [kidInput, setKidInput] = useState("");
  const [kids, setKids] = useState<string[]>([]);
  const [kidsError, setKidsError] = useState<string | null>(null);
  const [street, setStreet] = useState("");
  const [zip, setZip] = useState("");
  const [coParentName, setCoParentName] = useState<string | null>(null);
  const coParentCode = useRef(new URLSearchParams(window.location.search).get("coparent")).current;

  const [wantsCoParentLink, setWantsCoParentLink] = useState(false);
  const [coParentCodeInput, setCoParentCodeInput] = useState("");
  const [linkingCoParent, setLinkingCoParent] = useState(false);
  const [coParentLinkError, setCoParentLinkError] = useState<string | null>(null);

  const handleNameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCheckingName(true);
    setNameError(null);
    try {
      const result = await claimName(trimmed, memberId);
      if (result.recovered) {
        onRecoverMemberId(result.memberId);
        setReturning(true);
        // Prefill from their actual saved profile, not a carpool membership
        // snapshot — a carpool only ever has the subset of kids assigned to
        // it, not the full roster.
        try {
          const known = await getServerProfile(result.memberId);
          if (known) {
            setKids(known.kids);
            setStreet(known.street);
            setZip(known.zip);
          }
        } catch {
          // No prior profile to recover from — fine, they'll just fill it in.
        }
        setStep(2);
      } else {
        setReturning(false);
        if (coParentCode) {
          try {
            const link = await linkHousehold(coParentCode, memberId);
            setCoParentName(link.coParentName);
            setKids(link.coParentKids);
          } catch {
            // Bad/expired invite code — fine, they just fill their own info in.
          }
          setStep(2);
        } else {
          // No invite link in the URL — ask directly rather than letting them
          // type kid names blind that might already exist, differently
          // spelled, on a co-parent's account.
          setStep("coparent");
        }
      }
    } catch {
      setNameError("Couldn't check that name. Try again.");
    } finally {
      setCheckingName(false);
    }
  };

  const handleCoParentCodeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = coParentCodeInput.trim();
    if (!trimmed) return;
    setLinkingCoParent(true);
    setCoParentLinkError(null);
    try {
      const link = await linkHousehold(trimmed, memberId);
      setCoParentName(link.coParentName);
      setKids(link.coParentKids);
      setStep(2);
    } catch {
      setCoParentLinkError("That code didn't work — double check it and try again.");
    } finally {
      setLinkingCoParent(false);
    }
  };

  const addKid = () => {
    const trimmed = kidInput.trim();
    if (!trimmed) return;
    setKids((prev) => [...prev, trimmed]);
    setKidInput("");
    setKidsError(null);
  };

  const handleKidKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKid();
    }
  };

  const removeKid = (index: number) => {
    setKids((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFinish = (e: FormEvent) => {
    e.preventDefault();
    if (kids.length === 0) {
      setKidsError("Add at least one kid — carpools are organized by kid.");
      return;
    }
    onSubmit({ name: name.trim(), kids, street: street.trim(), zip: zip.trim() });
  };

  if (step === 0) {
    return (
      <div className="gate-card">
        <h2 className="gate-heading">Before you join</h2>
        <div className="gate-alpha-warning">
          <p>
            <strong>blisspool is in early alpha testing.</strong> It has no login or security
            yet — anything you enter here, including names, addresses, and children&rsquo;s
            names, is <strong>publicly visible on the internet</strong> to anyone with the link.
          </p>
          <p>Please don&rsquo;t enter anything you&rsquo;re not comfortable being public right now.</p>
          <p>
            We&rsquo;ll add proper secure authentication before this leaves testing — this
            warning will go away once that happens.
          </p>
        </div>
        <button type="button" className="pill-button" onClick={() => setStep(1)}>
          I understand, continue →
        </button>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="gate-card">
        <span className="gate-step">Step 1 of 2</span>
        <h2 className="gate-heading">Who&rsquo;s joining?</h2>
        <p className="gate-sub">Pick your name — this is how others will see you.</p>
        <form className="gate-form" onSubmit={handleNameSubmit}>
          <input
            className="gate-input"
            placeholder="Your first and last name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            autoFocus
            required
          />
          {nameError && <p className="form-error">{nameError}</p>}
          <button type="submit" className="pill-button" disabled={checkingName}>
            {checkingName ? "Checking..." : "Continue →"}
          </button>
        </form>
        <p className="gate-fineprint">
          No password. No email. Already have a name here? Just type it again.
        </p>
      </div>
    );
  }

  if (step === "coparent") {
    return (
      <div className="gate-card pop-in">
        <h2 className="gate-heading">Is your co-parent already using blisspool?</h2>
        <p className="gate-sub">
          If they&rsquo;ve already added your kids, we can pull their exact names in instead of
          you retyping them — that way carpools don&rsquo;t end up treating &ldquo;Will&rdquo;
          and &ldquo;William&rdquo; as two different kids.
        </p>
        {!wantsCoParentLink ? (
          <div className="gate-form">
            <button type="button" className="pill-button" onClick={() => setWantsCoParentLink(true)}>
              Yes, link us up →
            </button>
            <button type="button" className="pill-button secondary" onClick={() => setStep(2)}>
              No / not yet
            </button>
          </div>
        ) : (
          <form className="gate-form" onSubmit={handleCoParentCodeSubmit}>
            <input
              className="gate-input"
              placeholder="Their invite code"
              value={coParentCodeInput}
              onChange={(e) => {
                setCoParentCodeInput(e.target.value);
                setCoParentLinkError(null);
              }}
              autoFocus
              required
            />
            {coParentLinkError && <p className="form-error">{coParentLinkError}</p>}
            <button type="submit" className="pill-button" disabled={linkingCoParent}>
              {linkingCoParent ? "Linking..." : "Link us up →"}
            </button>
            <button type="button" className="pill-button secondary" onClick={() => setStep(2)}>
              Skip for now
            </button>
          </form>
        )}
      </div>
    );
  }

  return (
    <>
    <div className="gate-card pop-in">
      <span className="gate-step">Step 2 of 2</span>
      <h2 className="gate-heading">
        {returning
          ? `Welcome back, ${name.trim().split(" ")[0]}.`
          : `Nice to meet you, ${name.trim().split(" ")[0]}.`}
      </h2>
      <p className="gate-sub">
        {returning
          ? "Confirm this still looks right."
          : "A little about you helps everyone plan rides."}
      </p>
      {coParentName && (
        <p className="gate-sub coparent-note">
          Linked as a co-parent with <strong>{coParentName}</strong> — their kids are pre-filled below.
        </p>
      )}
      <form id="gate-step2-form" className="gate-form gate-form-with-footer" onSubmit={handleFinish}>
        <div className="gate-field">
          <span className="gate-field-label">Your kids</span>
          <div className="kid-input-row">
            <input
              className="gate-input"
              placeholder="Kid's name, then Enter"
              value={kidInput}
              onChange={(e) => setKidInput(e.target.value)}
              onKeyDown={handleKidKeyDown}
            />
            <button type="button" className="pill-button secondary small" onClick={addKid}>
              Add
            </button>
          </div>
          {kids.length > 0 && (
            <div className="kid-tags">
              {kids.map((kid, i) => (
                <span className="kid-tag pop-in" key={`${kid}-${i}`}>
                  {kid}
                  <button type="button" onClick={() => removeKid(i)} aria-label={`Remove ${kid}`}>
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
          {kidsError && <p className="form-error">{kidsError}</p>}
        </div>

        <div className="gate-field">
          <span className="gate-field-label">Street address</span>
          <input
            className="gate-input"
            placeholder="123 Main St"
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            required
          />
        </div>
        <div className="gate-field">
          <span className="gate-field-label">Zip code</span>
          <input
            className="gate-input"
            placeholder="94587"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            inputMode="numeric"
            required
          />
        </div>
      </form>
    </div>
    <div className="floating-save-bar">
      <button type="submit" form="gate-step2-form" className="pill-button">
        {returning ? "That's me →" : "Parental Synergistic Bliss →"}
      </button>
    </div>
    </>
  );
}
