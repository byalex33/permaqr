import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { CodeRecord } from "../../shared/types";
import "./app.css";
import { Analytics } from "./analytics";
import { ApiError, api, downloadExport } from "./api";
import { Designer } from "./designer";

type Tab = "link" | "design" | "analytics";
type Pane = "code" | "settings";

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

function Studio() {
  const [ready, setReady] = useState(false);
  const [codes, setCodes] = useState<CodeRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("link");
  const [pane, setPane] = useState<Pane>("code");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [fallback, setFallback] = useState("");
  const [notice, setNotice] = useState("");

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
    api<{ authenticated: boolean }>("/api/session")
      .then(async (session) => {
        if (!session.authenticated) {
          location.href = "/login";
          return;
        }
        await load();
        setReady(true);
      })
      .catch(() => {
        location.href = "/login";
      });
  }, [load]);

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
          <a href="/site">Landing</a>
          <button
            type="button"
            onClick={() => {
              void api("/api/logout", { method: "POST" }).then(() => {
                location.href = "/";
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
                    <strong>/{code.slug}</strong>
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
          {pane === "settings" ? (
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
  tab,
  onTab,
  onChange,
  onDeleted,
}: {
  code: CodeRecord;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onChange: (code: CodeRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const shortUrl = `${location.origin}/${code.slug}`;
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
          <h2>/{code.slug}</h2>
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
          <p>Delete /{code.slug}? Printed copies of this code will stop working.</p>
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

const path = location.pathname;
render(path.startsWith("/login") ? <Login /> : <Studio />, document.querySelector("#app")!);
