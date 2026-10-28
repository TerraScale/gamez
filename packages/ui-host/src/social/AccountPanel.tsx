/**
 * Sign in / register / link / display name (wave-B.md §3, §8.3). A guest sees
 * the "Save your progress" form (register upgrades the guest in place); a
 * registered account sees its name, linked logins and sign out. Presentational
 * parts are exported for tests.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type AccountView,
  type ProviderInfo,
} from "@gamez/protocol";
import type { AuthApi } from "../platform.ts";
import { useLoad } from "./hooks.ts";
import {
  linkedProviders,
  loginAccount,
  oauthProviders,
  registerAccount,
  saveDisplayName,
  type LoginForm,
  type RegisterForm,
} from "./flows.ts";
import { providerButtonText, providerLabel, validateDisplayName } from "./text.ts";
import {
  SOCIAL_TOUCH,
  badgeStyle,
  errorTextStyle,
  fieldLabelStyle,
  headingStyle,
  inputStyle,
  listStyle,
  mutedStyle,
  okTextStyle,
  rowStyle,
  sheetStyle,
  socialButtonStyle,
  subheadingStyle,
} from "./styles.ts";

export interface AccountPanelProps {
  auth: AuthApi;
  account: AccountView | null;
  /** Called after any successful auth change, saying which one. */
  onChanged?: (change: AccountChange) => void;
  compact?: boolean;
}

/** What a successful AccountPanel action did (the host picks its notice from it). */
export type AccountChange = "registered" | "signed-in" | "renamed" | "signed-out";

/** The host's one-line notice for a change. */
export function accountChangeText(change: AccountChange): string {
  switch (change) {
    case "registered":
      return "Account created. Your progress is saved.";
    case "signed-in":
      return "Signed in.";
    case "renamed":
      return "Name saved.";
    case "signed-out":
      return "Signed out.";
  }
}

export function AccountPanel({ auth, account, onChanged, compact = false }: AccountPanelProps) {
  const providers = useLoad<ProviderInfo[]>(
    () => auth.providers().catch((): ProviderInfo[] => []),
    [auth],
  );
  const style = { ...sheetStyle, padding: compact ? 8 : 12 };
  if (!account) {
    return (
      <section aria-label="Account" style={style}>
        <p role="status" style={mutedStyle}>
          Loading account…
        </p>
      </section>
    );
  }
  if (account.kind === "guest") {
    return (
      <section aria-label="Account" style={style}>
        <GuestAccount auth={auth} providers={providers ?? []} onChanged={onChanged} />
      </section>
    );
  }
  return (
    <section aria-label="Account" style={style}>
      <RegisteredAccount
        key={`${account.accountId}:${account.displayName}`}
        auth={auth}
        account={account}
        providers={providers ?? []}
        onChanged={onChanged}
      />
    </section>
  );
}

function goTo(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

// ---------------------------------------------------------------------------
// Guest: save progress, sign in
// ---------------------------------------------------------------------------

export function GuestAccount({
  auth,
  providers,
  onChanged,
}: {
  auth: AuthApi;
  providers: readonly ProviderInfo[];
  onChanged?: (change: AccountChange) => void;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  return (
    <>
      <h2 style={headingStyle}>Save your progress</h2>
      <p style={mutedStyle}>
        Create an account to keep this hero on any device. Your progress is kept when you register.
      </p>
      <div role="tablist" aria-label="Account options" style={rowStyle}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "register"}
          onClick={() => setMode("register")}
          style={tabLook(mode === "register")}
        >
          Create account
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          onClick={() => setMode("login")}
          style={tabLook(mode === "login")}
        >
          I have an account
        </button>
      </div>
      {mode === "register" ? (
        <RegisterFormView auth={auth} onChanged={onChanged} />
      ) : (
        <LoginFormView auth={auth} onChanged={onChanged} />
      )}
      <ProviderButtons providers={providers} auth={auth} link={false} />
    </>
  );
}

function tabLook(selected: boolean) {
  return {
    ...socialButtonStyle({ pressed: selected }),
    flex: "1 1 140px",
    fontWeight: selected ? 700 : 600,
  };
}

export function RegisterFormView({
  auth,
  onChanged,
}: {
  auth: AuthApi;
  onChanged?: (change: AccountChange) => void;
}) {
  const [form, setForm] = useState<RegisterForm>({ email: "", password: "", displayName: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void registerAccount(auth, form).then((r) => {
      setBusy(false);
      if (r.ok) onChanged?.("registered");
      else setError(r.message);
    });
  };

  return (
    // noValidate: the app's own checks speak plain language (not the browser's bubble).
    <form onSubmit={submit} aria-label="Create account" noValidate style={formLook}>
      <Field label="Email">
        <input
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <Field label="Password" hint={`At least ${PASSWORD_MIN} characters (up to ${PASSWORD_MAX}).`}>
        <input
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <Field
        label="Display name (optional)"
        hint={`${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters.`}
      >
        <input
          type="text"
          autoComplete="nickname"
          value={form.displayName}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          style={inputStyle}
        />
      </Field>
      {error ? (
        <p role="alert" style={errorTextStyle}>
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        style={socialButtonStyle({ primary: true, disabled: busy, fullWidth: true })}
      >
        {busy ? "Saving…" : "Save progress"}
      </button>
    </form>
  );
}

export function LoginFormView({
  auth,
  onChanged,
}: {
  auth: AuthApi;
  onChanged?: (change: AccountChange) => void;
}) {
  const [form, setForm] = useState<LoginForm>({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void loginAccount(auth, form).then((r) => {
      setBusy(false);
      if (r.ok) onChanged?.("signed-in");
      else setError(r.message);
    });
  };

  return (
    <form onSubmit={submit} aria-label="Sign in" noValidate style={formLook}>
      <p style={mutedStyle}>
        Signing in switches this browser to that account. Progress made as a guest stays with the
        guest.
      </p>
      <Field label="Email">
        <input
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          autoComplete="current-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          style={inputStyle}
        />
      </Field>
      {error ? (
        <p role="alert" style={errorTextStyle}>
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        style={socialButtonStyle({ primary: true, disabled: busy, fullWidth: true })}
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Registered: name, linked logins, sign out
// ---------------------------------------------------------------------------

export function RegisteredAccount({
  auth,
  account,
  providers,
  onChanged,
}: {
  auth: AuthApi;
  account: AccountView;
  providers: readonly ProviderInfo[];
  onChanged?: (change: AccountChange) => void;
}) {
  const [name, setName] = useState(account.displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameNotice, setNameNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = linkedProviders(account);
  const nameProblem = validateDisplayName(name);

  const saveName = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setNameError(null);
    setNameNotice(null);
    setBusy(true);
    void saveDisplayName(auth, name).then((r) => {
      setBusy(false);
      if (r.ok) {
        setNameNotice("Name saved.");
        onChanged?.("renamed");
      } else {
        setNameError(r.message);
      }
    });
  };

  const signOut = () => {
    setBusy(true);
    void auth.logout().then(() => {
      setBusy(false);
      onChanged?.("signed-out");
    });
  };

  const unlinked = oauthProviders(providers).filter((p) => !linked.has(p.id));

  return (
    <>
      <h2 style={headingStyle}>{account.displayName}</h2>
      <p style={mutedStyle}>
        {`Account · ${account.identities.length === 0 ? "no logins linked" : "signed in"}`}
      </p>

      <form onSubmit={saveName} aria-label="Display name" style={formLook}>
        <Field label="Display name" hint={nameProblem ?? "3 to 20 characters."}>
          <input
            type="text"
            aria-label="Display name"
            value={name}
            maxLength={DISPLAY_NAME_MAX}
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </Field>
        {nameError ? (
          <p role="alert" style={errorTextStyle}>
            {nameError}
          </p>
        ) : null}
        {nameNotice ? (
          <p role="status" style={okTextStyle}>
            {nameNotice}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || nameProblem !== null || name.trim() === account.displayName}
          style={socialButtonStyle({
            disabled: busy || nameProblem !== null || name.trim() === account.displayName,
          })}
        >
          Save name
        </button>
      </form>

      <h3 style={subheadingStyle}>Linked logins</h3>
      <ul aria-label="Linked logins" style={listStyle}>
        {account.identities.map((i) => (
          <li key={i.provider} style={{ ...rowStyle, minHeight: SOCIAL_TOUCH }}>
            <span style={{ fontWeight: 700 }}>{providerLabel(i.provider)}</span>
            {i.email ? <span style={mutedStyle}>{i.email}</span> : null}
            <span style={badgeStyle}>Linked</span>
          </li>
        ))}
        {account.identities.length === 0 ? <li style={mutedStyle}>No logins linked yet.</li> : null}
      </ul>
      {unlinked.length > 0 ? (
        <>
          <p style={mutedStyle}>Link another sign-in to this account:</p>
          <ProviderButtons providers={unlinked} auth={auth} link={true} />
        </>
      ) : null}

      <p style={mutedStyle}>Signing out keeps your progress on this account.</p>
      <button
        type="button"
        disabled={busy}
        onClick={signOut}
        style={socialButtonStyle({ danger: true, disabled: busy, fullWidth: true })}
      >
        Sign out
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

export function ProviderButtons({
  providers,
  auth,
  link,
}: {
  providers: readonly ProviderInfo[];
  auth: AuthApi;
  link: boolean;
}) {
  const oauth = oauthProviders(providers);
  if (oauth.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={link ? "Link a sign-in" : "Or continue with"}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <p style={mutedStyle}>{link ? "Link a sign-in" : "Or continue with"}</p>
      {oauth.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={!p.enabled}
          onClick={() => goTo(auth.oauthUrl(p.id, { link }))}
          style={socialButtonStyle({ disabled: !p.enabled, fullWidth: true })}
        >
          {providerButtonText(p)}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label
      style={{ ...fieldLabelStyle, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
    >
      {label}
      {children}
      {hint ? <span style={{ ...mutedStyle, fontSize: 11 }}>{hint}</span> : null}
    </label>
  );
}

const formLook = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
} as const;
