import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { CodeRecord } from "../../shared/types";
import "./app.css";
import { Analytics } from "./analytics";
import { ApiError, api, downloadExport } from "./api";
import { Designer } from "./designer";

type Tab = "link" | "design" | "analytics";
type Pane = "code" | "settings" | "accounts";
type StudioMode = "operator" | "account";

type AccountSummary = {
  id: string;
  email: string;
  handle: string;
  disabled: boolean;
  password_set: boolean;
  code_count: number;
  test_mode: boolean;
  created_at: number;
};

function Mark() {
  return (
    <span class="mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
      location.href = "/app";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in");
      setPending(false);
    }
  }

  return (
    <main class="login-wrap">
      <form class="sheet login-card" onSubmit={(event) => void submit(event)}>
        <p class="brand">
          <Mark /> PermaQR
        </p>
        <h1>One password. The rest is yours.</h1>
        <p class="lede">This dashboard is protected by the Worker secret you set as ADMIN_PASSWORD.</p>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </label>
        {error ? <p class="error">{error}</p> : null}
        <button class="btn btn-stamp" type="submit" disabled={pending}>
          {pending ? "Checking…" : "Open dashboard"}
        </button>
      </form>
    </main>
  );
}

function AccountLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await api("/api/account/login", { method: "POST", body: JSON.stringify({ email, password }) });
      location.href = "/account";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in");
      setPending(false);
    }
  }

  return (
    <main class="login-wrap">
      <form class="sheet login-card" onSubmit={(event) => void submit(event)}>
        <p class="brand">
          <Mark /> PermaQR
        </p>
        <h1>Your hosted workspace.</h1>
        <p class="lede">Sign in with the email you paid with and the password you set after checkout.</p>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onInput={(event) => setEmail(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
          />
        </label>
        {error ? <p class="error">{error}</p> : null}
        <button class="btn btn-stamp" type="submit" disabled={pending}>
          {pending ? "Checking…" : "Open dashboard"}
        </button>
        <p class="hint">
          First time here? Use the setup link from the checkout page.{" "}
          <a href="/welcome">Open the setup page</a>
        </p>
      </form>
    </main>
  );
}

function Setup() {
  const params = new URLSearchParams(location.search);
  const [token] = useState(params.get("token") ?? "");
  const [orderIdentifier, setOrderIdentifier] = useState(params.get("order_identifier") ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"wait" | "ready" | "done">(token ? "ready" : "wait");
  const [note, setNote] = useState(token ? "Choose a password for this workspace." : "Waiting for the payment notification.");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (token) return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        let identifier = orderIdentifier;
        if (!identifier) {
          const claimed = await api<{ status: string; order_identifier?: string; email?: string }>("/api/hosted/claim", {
            method: "POST",
          });
          if (stopped) return;
          if (claimed.status === "missing") {
            setNote("No checkout is in progress in this browser. Use the link from the payment confirmation, or start checkout again.");
            return;
          }
          if (claimed.status !== "ready" || !claimed.order_identifier) {
            setNote("Waiting for the payment notification. This usually takes a few seconds.");
            return;
          }
          identifier = claimed.order_identifier;
          setOrderIdentifier(identifier);
          if (claimed.email) setEmail(claimed.email);
        }
        const order = await api<{ status: string; email?: string; password_set?: boolean; disabled?: boolean }>(
          `/api/hosted/order?order_identifier=${encodeURIComponent(identifier)}`,
        );
        if (stopped) return;
        if (order.status !== "ready") {
          setNote("Waiting for the payment notification. This usually takes a few seconds.");
          return;
        }
        if (order.email) setEmail(order.email);
        if (order.disabled) {
          setNote("This workspace is disabled.");
          return;
        }
        if (order.password_set) {
          setStatus("done");
          setNote("A password is already set.");
          return;
        }
        setStatus("ready");
        setNote("Payment received. Set a password. The link works for 7 days, or until you set one.");
      } catch (cause) {
        if (!stopped) setNote(cause instanceof Error ? cause.message : "Still waiting.");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [orderIdentifier, token]);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }
    setPending(true);
    try {
      await api("/api/account/setup", {
        method: "POST",
        body: JSON.stringify({ password, token: token || undefined, order_identifier: orderIdentifier || undefined }),
      });
      location.href = "/account";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not set the password");
      setPending(false);
    }
  }

  return (
    <main class="login-wrap">
      <form class="sheet login-card" onSubmit={(event) => void submit(event)}>
        <p class="brand">
          <Mark /> PermaQR
        </p>
        <h1>Set a password.</h1>
        <p class="lede">{note}</p>
        {email ? <p class="hint">Workspace for {email}</p> : null}
        {status === "done" ? (
          <a class="btn btn-stamp" href="/account/login">
            Sign in
          </a>
        ) : null}
        {status === "ready" ? (
          <>
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={password}
                onInput={(event) => setPassword(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={confirm}
                onInput={(event) => setConfirm(event.currentTarget.value)}
                required
              />
            </label>
            {error ? <p class="error">{error}</p> : null}
            <button class="btn btn-stamp" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save password"}
            </button>
          </>
        ) : null}
      </form>
    </main>
  );
}

function Studio({ mode }: { mode: StudioMode }) {
  const [ready, setReady] = useState(false);
  const [codes, setCodes] = useState<CodeRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("link");
  const [pane, setPane] = useState<Pane>("code");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [fallback, setFallback] = useState("");
  const [notice, setNotice] = useState("");
  const [handle, setHandle] = useState("");
  const [hosted, setHosted] = useState(false);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);

  const load = useCallback(async () => {
    const [list, settings] = await Promise.all([
      api<{ codes: CodeRecord[] }>("/api/codes"),
      api<{ fallback_message: string }>("/api/settings"),
    ]);
    setCodes(list.codes);
    setFallback(settings.fallback_message);
    setSelectedId((current) => current ?? list.codes[0]?.id ?? null);
  }, []);

  useEffect(() => {
    const sessionPath = mode === "account" ? "/api/account/session" : "/api/session";
    const loginPath = mode === "account" ? "/account/login" : "/login";
    api<{ authenticated: boolean; handle?: string }>(sessionPath)
      .then(async (session) => {
        if (!session.authenticated) {
          location.href = loginPath;
          return;
        }
        if (session.handle) setHandle(session.handle);
        if (mode === "operator") {
          const config = await api<{ hosted?: boolean }>("/api/config");
          setHosted(Boolean(config.hosted));
        }
        await load();
        setReady(true);
      })
      .catch(() => {
        location.href = loginPath;
      });
  }, [load, mode]);

  const pathPrefix = mode === "account" && handle ? `/u/${handle}` : "";

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return codes;
    return codes.filter((code) => `${code.slug} ${code.title} ${code.destination}`.toLowerCase().includes(needle));
  }, [codes, query]);

  const selected = codes.find((code) => code.id === selectedId) ?? null;

  function replaceCode(next: CodeRecord): void {
    setCodes((current) => current.map((code) => (code.id === next.id ? next : code)));
  }

  async function onImport(file: File | undefined): Promise<void> {
    if (!file) return;
    setError("");
    const text = await file.text();
    const format = file.name.endsWith(".csv") || text.trimStart().startsWith("slug,") ? "csv" : "json";
    try {
      const result = await api<{ created: number; updated: number; errors: string[] }>(
        `/api/import?format=${format}&mode=merge`,
        { method: "POST", body: text, headers: { "content-type": format === "csv" ? "text/csv" : "application/json" } },
      );
      setNotice(`Imported ${result.created} new and updated ${result.updated}.${result.errors[0] ? ` ${result.errors[0]}` : ""}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
    }
  }

  if (!ready) {
    return <main class="boot">Opening the studio…</main>;
  }

  return (
    <div class="studio">
      <header class="top">
        <p class="brand">
          <Mark /> PermaQR
          {pathPrefix ? <span class="hint"> {pathPrefix}/</span> : null}
        </p>
        <div class="top-actions">
          <button type="button" onClick={() => void downloadExport("json")}>
            Export JSON
          </button>
          <button type="button" onClick={() => void downloadExport("csv")}>
            Export CSV
          </button>
          <label class="file-btn">
            Import
            <input
              type="file"
              accept="application/json,text/csv,.json,.csv"
              onChange={(event) => void onImport(event.currentTarget.files?.[0])}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setPane("settings");
              setSelectedId(null);
            }}
          >
            Fallback page
          </button>
          {hosted && mode === "operator" ? (
            <button
              type="button"
              onClick={() => {
                setPane("accounts");
                setSelectedId(null);
                void api<{ accounts: AccountSummary[] }>("/api/operator/accounts")
                  .then((result) => setAccounts(result.accounts))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load accounts"));
              }}
            >
              Hosted accounts
            </button>
          ) : null}
          <a href="/site">Landing</a>
          <button
            type="button"
            onClick={() => {
              void api("/api/logout", { method: "POST" }).then(() => {
                location.href = mode === "account" ? "/account/login" : "/";
              });
            }}
          >
            Log out
          </button>
        </div>
      </header>
      {error ? <p class="banner error">{error}</p> : null}
      {notice ? <p class="banner">{notice}</p> : null}
      <div class="workspace">
        <aside>
          <CreateForm
            onCreated={(code) => {
              setCodes((current) => [code, ...current.filter((item) => item.id !== code.id)]);
              setSelectedId(code.id);
              setPane("code");
              setTab("design");
              setNotice("");
            }}
          />
          <label class="filter">
            Filter
            <input value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="slug or destination" />
          </label>
          <ul class="code-list">
            {visible.length === 0 ? <li class="empty-list">No codes yet.</li> : null}
            {visible.map((code) => (
              <li key={code.id}>
                <button
                  type="button"
                  class={code.id === selectedId ? "ticket on" : "ticket"}
                  onClick={() => {
                    setSelectedId(code.id);
                    setPane("code");
                  }}
                >
                  <span class="ticket-top">
                    <strong>
                      {pathPrefix}/{code.slug}
                    </strong>
                    <span>{code.paused ? "Paused" : `${code.scans} scans`}</span>
                  </span>
                  <span class="ticket-title">{code.title || "Untitled"}</span>
                  <span class="ticket-dest">{code.destination}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section class="detail">
          {pane === "accounts" ? (
            <Accounts
              accounts={accounts}
              onChange={setAccounts}
              onNotice={setNotice}
              onError={setError}
            />
          ) : pane === "settings" ? (
            <Settings
              message={fallback}
              onChange={setFallback}
              onSaved={(message) => {
                setFallback(message);
                setNotice("Fallback page saved.");
              }}
            />
          ) : selected ? (
            <CodeDetail
              code={selected}
              pathPrefix={pathPrefix}
              tab={tab}
              onTab={setTab}
              onChange={replaceCode}
              onDeleted={(id) => {
                const next = codes.filter((code) => code.id !== id);
                setCodes(next);
                setSelectedId(next[0]?.id ?? null);
              }}
            />
          ) : (
            <div class="sheet welcome">
              <p class="kicker">Nothing printed yet</p>
              <h2>Make a code you can leave on a wall.</h2>
              <p>The short link is permanent. The destination is the part you can change.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: (code: CodeRecord) => void }) {
  const [open, setOpen] = useState(true);
  const [destination, setDestination] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await api<{ code: CodeRecord }>("/api/codes", {
        method: "POST",
        body: JSON.stringify({ destination, title, slug: slug.trim() || undefined }),
      });
      setDestination("");
      setTitle("");
      setSlug("");
      onCreated(result.code);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create the code");
    } finally {
      setPending(false);
    }
  }

  return (
    <form class="create" onSubmit={(event) => void submit(event)}>
      <button type="button" class="create-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? "New code" : "New code"}
      </button>
      {open ? (
        <>
          <label>
            Destination
            <input
              required
              type="url"
              placeholder="https://"
              value={destination}
              onInput={(event) => setDestination(event.currentTarget.value)}
            />
          </label>
          <label>
            Title
            <input value={title} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Lunch menu" />
          </label>
          <label>
            Short code
            <input value={slug} onInput={(event) => setSlug(event.currentTarget.value)} placeholder="optional, like menu" />
          </label>
          {error ? <p class="error">{error}</p> : null}
          <button class="btn btn-stamp" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create code"}
          </button>
        </>
      ) : null}
    </form>
  );
}

function CodeDetail({
  code,
  pathPrefix,
  tab,
  onTab,
  onChange,
  onDeleted,
}: {
  code: CodeRecord;
  pathPrefix: string;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onChange: (code: CodeRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const label = `${pathPrefix}/${code.slug}`;
  const shortUrl = `${location.origin}${label}`;
  const [title, setTitle] = useState(code.title);
  const [destination, setDestination] = useState(code.destination);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setTitle(code.title);
    setDestination(code.destination);
    setError("");
    setConfirming(false);
  }, [code.id, code.updated_at, code.title, code.destination]);

  async function saveLink(event: Event): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ code: CodeRecord }>(`/api/codes/${code.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title, destination }),
      });
      onChange(result.code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save");
    }
  }

  async function togglePause(): Promise<void> {
    const result = await api<{ code: CodeRecord }>(`/api/codes/${code.id}`, {
      method: "PATCH",
      body: JSON.stringify({ paused: !code.paused }),
    });
    onChange(result.code);
  }

  async function remove(): Promise<void> {
    await api(`/api/codes/${code.id}`, { method: "DELETE" });
    onDeleted(code.id);
  }

  return (
    <div class="sheet code-sheet">
      <header class="code-head">
        <div>
          <p class="kicker">{code.paused ? "Paused" : "Live"}</p>
          <h2>{label}</h2>
          <p class="permanent">The short code is permanent. The destination is not.</p>
        </div>
        <div class="code-actions">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(shortUrl).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button type="button" onClick={() => void togglePause()}>
            {code.paused ? "Resume" : "Pause"}
          </button>
          <button type="button" class="danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      </header>
      {confirming ? (
        <div class="confirm">
          <p>Delete {label}? Printed copies of this code will stop working.</p>
          <button type="button" class="danger" onClick={() => void remove()}>
            Delete code
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      ) : null}
      <div class="tabs" role="tablist">
        {(
          [
            ["link", "Link"],
            ["design", "Design"],
            ["analytics", "Analytics"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} class={tab === id ? "on" : ""} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div hidden={tab !== "design"}>
        <Designer key={code.id} code={code} shortUrl={shortUrl} onSaved={onChange} />
      </div>
      {tab === "link" ? (
        <form class="link-form" onSubmit={(event) => void saveLink(event)}>
          <label>
            Title
            <input value={title} onInput={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <label>
            Destination
            <input required type="url" value={destination} onInput={(event) => setDestination(event.currentTarget.value)} />
          </label>
          <p class="short-url">{shortUrl}</p>
          {error ? <p class="error">{error}</p> : null}
          <button class="btn btn-stamp" type="submit">
            Save destination
          </button>
        </form>
      ) : null}
      {tab === "analytics" ? <Analytics codeId={code.id} /> : null}
    </div>
  );
}

function Settings({
  message,
  onChange,
  onSaved,
}: {
  message: string;
  onChange: (value: string) => void;
  onSaved: (value: string) => void;
}) {
  const [error, setError] = useState("");
  async function save(event: Event): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ fallback_message: string }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ fallback_message: message }),
      });
      onSaved(result.fallback_message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save");
    }
  }
  return (
    <form class="sheet settings" onSubmit={(event) => void save(event)}>
      <p class="kicker">Unknown or paused</p>
      <h2>Fallback page</h2>
      <p>Shown when someone scans a code that is paused or does not exist. Keep it plain. No tracking.</p>
      <label>
        Message
        <textarea rows={5} maxLength={500} value={message} onInput={(event) => onChange(event.currentTarget.value)} />
      </label>
      {error ? <p class="error">{error}</p> : null}
      <button class="btn btn-stamp" type="submit">
        Save message
      </button>
    </form>
  );
}

function Accounts({
  accounts,
  onChange,
  onNotice,
  onError,
}: {
  accounts: AccountSummary[];
  onChange: (accounts: AccountSummary[]) => void;
  onNotice: (notice: string) => void;
  onError: (error: string) => void;
}) {
  async function act(id: string, action: "disable" | "enable" | "setup-link"): Promise<void> {
    onError("");
    try {
      const result = await api<{ setup_url?: string }>(`/api/operator/accounts/${id}/${action}`, { method: "POST" });
      if (action === "setup-link" && result.setup_url) {
        onNotice(`Setup link (shown once): ${result.setup_url}`);
      } else {
        onNotice(action === "disable" ? "Account disabled. Its codes stop resolving." : "Account enabled.");
      }
      const list = await api<{ accounts: AccountSummary[] }>("/api/operator/accounts");
      onChange(list.accounts);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not update the account");
    }
  }

  return (
    <div class="sheet settings">
      <p class="kicker">Operator</p>
      <h2>Hosted accounts</h2>
      <p>Each paid workspace is separate from your own codes. Disable stops its redirects. A setup link clears the password and must be sent by you.</p>
      {accounts.length === 0 ? <p class="empty-copy">No hosted accounts yet.</p> : null}
      <ul class="code-list">
        {accounts.map((account) => (
          <li key={account.id} class="ticket">
            <span class="ticket-top">
              <strong>/u/{account.handle}/</strong>
              <span>{account.disabled ? "Disabled" : `${account.code_count} codes`}</span>
            </span>
            <span class="ticket-title">{account.email}</span>
            <span class="ticket-dest">
              {account.password_set ? "Password set" : "Waiting for a password"}
              {account.test_mode ? " · test order" : ""}
            </span>
            <span class="code-actions">
              {account.disabled ? (
                <button type="button" onClick={() => void act(account.id, "enable")}>
                  Enable
                </button>
              ) : (
                <button type="button" onClick={() => void act(account.id, "disable")}>
                  Disable
                </button>
              )}
              <button type="button" onClick={() => void act(account.id, "setup-link")}>
                New setup link
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const path = location.pathname;
const page = path.startsWith("/login") ? (
  <Login />
) : path.startsWith("/account/login") ? (
  <AccountLogin />
) : path === "/welcome" || path.startsWith("/account/setup") ? (
  <Setup />
) : path.startsWith("/account") ? (
  <Studio mode="account" />
) : (
  <Studio mode="operator" />
);
render(page, document.querySelector("#app")!);
