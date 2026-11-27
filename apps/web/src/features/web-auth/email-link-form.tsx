"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiClient, ApiError, tokenStore, tokensFromResponse } from "../../lib/api";

export function EmailLinkForm() {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setToken(new URLSearchParams(window.location.hash.slice(1)).get("token"));
  }, []);

  async function confirm() {
    setWorking(true);
    setError("");
    try {
      const result = await apiClient.post("/auth/email/verify", { token }, { auth: false, retryOnUnauthorized: false });
      const tokens = tokensFromResponse(result);
      if (!tokens) throw new Error("Missing session token");
      tokenStore.set(tokens);
      window.history.replaceState(window.history.state, "", window.location.pathname);
      router.replace("/papers");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setToken(null);
      } else {
        setError("Couldn’t sign in. Try again in a moment.");
      }
      setWorking(false);
    }
  }

  return (
    <section className="wa-card" aria-labelledby="email-link-heading">
      <h1 id="email-link-heading" className="wa-title">Confirm email sign-in</h1>
      {token && (
        <button type="button" className="wa-button" onClick={confirm} disabled={working}>
          {working ? "Signing in…" : "Continue to Scholium"}
        </button>
      )}
      {token === null && (
        <p className="wa-error" role="alert">
          This link is invalid, expired, or has already been used.{" "}
          <Link className="wa-link" href="/signin">Request a new link</Link>.
        </p>
      )}
      {error && <p className="wa-error" role="alert">{error}</p>}
    </section>
  );
}
