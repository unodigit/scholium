"use client";

import { useState, type FormEvent } from "react";

import { apiClient, ApiError } from "../../lib/api";

export function EmailSignInForm({ signup }: { signup: boolean }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setStatus("");
    setError("");
    try {
      await apiClient.post("/auth/email/start", { email }, { auth: false });
      setStatus("Check your inbox for a sign-in link. It expires in 15 minutes.");
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 422
        ? "Enter a valid email address."
        : "Couldn’t send a sign-in link. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="wa-field wa-email-signin" onSubmit={submit}>
      <label className="wa-field-label" htmlFor="auth-email">Email address</label>
      <input
        className="wa-input"
        id="auth-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        maxLength={254}
        required
      />
      <button className="wa-button" type="submit" disabled={sending}>
        {sending ? "Sending link…" : signup ? "Sign up with email" : "Sign in with email"}
      </button>
      {status && <p className="wa-note" role="status">{status}</p>}
      {error && <p className="wa-error" role="alert">{error}</p>}
    </form>
  );
}
