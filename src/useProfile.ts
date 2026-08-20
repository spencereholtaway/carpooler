import { useEffect, useState } from "react";
import { saveServerProfile } from "./api";

const PROFILE_KEY = "blisspool:profile";
const MEMBER_ID_KEY = "blisspool:member-id";

export type LocalProfile = {
  name: string;
  kids: string[];
  street: string;
  zip: string;
};

export function useProfile() {
  const [profile, setProfileState] = useState<LocalProfile | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let id = localStorage.getItem(MEMBER_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(MEMBER_ID_KEY, id);
    }
    setMemberId(id);

    const raw = localStorage.getItem(PROFILE_KEY);
    setProfileState(raw ? (JSON.parse(raw) as LocalProfile) : null);
    setLoading(false);
  }, []);

  const saveProfile = (value: LocalProfile) => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(value));
    setProfileState(value);
    // Co-parent auto-join (and other cross-device lookups) needs a
    // server-side copy of the profile, since it otherwise only lives here.
    if (memberId) saveServerProfile(memberId, value);
  };

  const clearProfile = () => {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(MEMBER_ID_KEY);
    const id = crypto.randomUUID();
    localStorage.setItem(MEMBER_ID_KEY, id);
    setMemberId(id);
    setProfileState(null);
  };

  // Adopts an existing identity recovered by name (see claim-name), replacing
  // whatever fresh random member id this browser had generated.
  const adoptMemberId = (id: string) => {
    localStorage.setItem(MEMBER_ID_KEY, id);
    setMemberId(id);
  };

  return { profile, memberId, loading, saveProfile, clearProfile, adoptMemberId };
}
