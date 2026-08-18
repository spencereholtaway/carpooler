import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { Profile } from "./types";

export function useProfile(uid: string | undefined) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    return onSnapshot(doc(db, "profiles", uid), (snap) => {
      setProfile(snap.exists() ? (snap.data() as Profile) : null);
      setLoading(false);
    });
  }, [uid]);

  return { profile, loading };
}

export async function saveProfile(uid: string, profile: Profile) {
  await setDoc(doc(db, "profiles", uid), profile);
}
