import { useEffect, useState, type FormEvent } from "react";
import {
  AI_PROVIDERS,
  ENDPOINT_PRESETS,
  aiClis,
  aiProvider,
  isLocalEndpoint,
  matchingPreset,
  redescribeAll,
  testAiConnection,
  type AiClis,
  type AiPreferences,
  type AiProvider,
} from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

interface Props {
  saved: AiPreferences;
  disabled: boolean;
  /** Saves the AI preferences; resolves to whether they were saved. */
  onSave: (ai: AiPreferences) => Promise<boolean>;
}

type Result = { kind: "ok" | "error" | "info"; message: string } | null;

interface Draft {
  endpoint: string;
  model: string;
  apiKey: string;
}

const draftOf = (ai: AiPreferences): Draft => ({ endpoint: ai.endpoint, model: ai.model, apiKey: ai.apiKey ?? "" });

/** Where each provider sends screenshots. */
const PRIVACY: Record<AiProvider, string> = {
  claudeCode:
    "Claude Code sends your screenshots, with their text, app and window title, to Anthropic under your Claude account.",
  codex:
    "Codex sends your screenshots, with their text, app and window title, to OpenAI under your ChatGPT or OpenAI account.",
  endpoint:
    "With a local endpoint such as Ollama nothing leaves this computer; a cloud endpoint receives your screenshots.",
};

/**
 * Who describes and sorts captures. The toggles and the provider save at
 * once; the endpoint's text fields save with Save, or before a connection
 * test. A preset only fills in those fields.
 */
function AiSection({ saved, disabled, onSave }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [result, setResult] = useState<Result>(null);
  const [testing, setTesting] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  // Null until the backend has looked, or when it cannot say.
  const [clis, setClis] = useState<AiClis | null>(null);

  useEffect(() => {
    let cancelled = false;
    aiClis()
      .then((found) => {
        if (!cancelled) setClis(found);
      })
      .catch(() => {
        // Without it Settings just cannot warn that a CLI is missing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = aiProvider(saved);
  const usesEndpoint = provider === "endpoint";
  const typedValid = draft.endpoint.trim().length > 0 && draft.model.trim().length > 0;
  const edited =
    usesEndpoint &&
    (draft.endpoint.trim() !== saved.endpoint ||
      draft.model.trim() !== saved.model ||
      (draft.apiKey.trim() || null) !== saved.apiKey);
  const valid = !usesEndpoint || typedValid;
  const busy = disabled || testing;
  // The chosen CLI provider's name and command, when Grab-it looked and could not find it.
  const missing =
    clis === null
      ? null
      : provider === "claudeCode" && clis.claudeCode === null
        ? { name: "Claude Code", command: "claude" }
        : provider === "codex" && clis.codex === null
          ? { name: "Codex", command: "codex" }
          : null;

  /** Saves the typed fields along with `change`. */
  async function save(change: Partial<AiPreferences> = {}): Promise<boolean> {
    const next: AiPreferences = {
      ...saved,
      ...(usesEndpoint && typedValid
        ? { endpoint: draft.endpoint.trim(), model: draft.model.trim(), apiKey: draft.apiKey.trim() || null }
        : {}),
      ...change,
    };
    const ok = await onSave(next);
    if (ok) setDraft(draftOf(next));
    return ok;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && edited) void save();
  }

  async function test() {
    setResult(null);
    setTesting(true);
    try {
      // The backend tests what is saved, so save what is typed first.
      if (edited && !(await save())) return;
      const info = await testAiConnection();
      setResult({ kind: "ok", message: info ? `Connected: ${info}` : "Connected." });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  async function describeAll() {
    setConfirmingAll(false);
    setResult(null);
    try {
      await redescribeAll();
      setResult({ kind: "info", message: "Describing every capture again. The Library shows the progress." });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    }
  }

  const local = usesEndpoint && isLocalEndpoint(draft.endpoint.trim());
  // The menu follows the fields, so typing your own shows "Custom".
  const preset = matchingPreset(draft.endpoint.trim(), draft.model.trim());

  function choosePreset(id: string) {
    const chosen = ENDPOINT_PRESETS.find((candidate) => candidate.id === id);
    if (!chosen) return;
    setResult(null);
    setDraft({ ...draft, endpoint: chosen.endpoint, model: chosen.model });
  }

  return (
    <form className="ai-settings" aria-labelledby="ai-heading" onSubmit={submit}>
      <h2 id="ai-heading">AI descriptions</h2>
      <label className="toggle first">
        <input
          type="checkbox"
          checked={saved.enabled}
          disabled={busy}
          onChange={(event) => void save({ enabled: event.target.checked })}
        />
        <span>
          <span className="choice-title">Describe captures with AI</span>
          <span className="hint">
            A vision model writes a short description, picks a category and suggests tags, so you can search
            for what is in a capture.
          </span>
        </span>
      </label>

      <fieldset className="choices ai-providers" disabled={busy}>
        <legend className="choice-title">Described by</legend>
        {AI_PROVIDERS.map((choice) => (
          <label className="choice" key={choice.value}>
            <input
              type="radio"
              name="ai-provider"
              value={choice.value}
              checked={provider === choice.value}
              onChange={() => {
                setResult(null);
                void save({ provider: choice.value });
              }}
            />
            <span>
              <span className="choice-title">{choice.title}</span>
              <span className="hint">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {missing && (
        <p className="hint ai-missing" data-testid="ai-missing">
          Grab-it cannot find {missing.name}: there is no {missing.command} command on this computer. Install{" "}
          {missing.name} and sign in, then reopen Settings, or choose another provider instead.
        </p>
      )}

      <p className={`hint ai-privacy${local ? "" : " ai-privacy-cloud"}`}>
        {PRIVACY[provider]}
      </p>

      {usesEndpoint && (
        <>
          <div className="field">
            <label htmlFor="ai-preset">Preset</label>
            <select
              id="ai-preset"
              value={preset?.id ?? ""}
              disabled={busy}
              onChange={(event) => choosePreset(event.target.value)}
            >
              <option value="">Custom</option>
              {ENDPOINT_PRESETS.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
            <p className="hint">Fills in the URL and a model. Cloud providers also need your API key.</p>
          </div>
          <div className="field">
            <label htmlFor="ai-endpoint">Endpoint URL</label>
            <input
              id="ai-endpoint"
              type="text"
              inputMode="url"
              spellCheck={false}
              value={draft.endpoint}
              disabled={busy}
              placeholder="http://localhost:11434/v1"
              onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
            />
            <p className="hint">Any OpenAI-compatible API, such as Ollama, LM Studio or a cloud provider.</p>
          </div>
          <div className="field">
            <label htmlFor="ai-model">Model</label>
            <input
              id="ai-model"
              type="text"
              spellCheck={false}
              value={draft.model}
              disabled={busy}
              placeholder="qwen3-vl:4b"
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
            <p className="hint">It must accept images.</p>
          </div>
          <div className="field">
            <label htmlFor="ai-api-key">API key</label>
            <input
              id="ai-api-key"
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              disabled={busy}
              placeholder="Optional"
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
            <p className="hint">Only cloud providers need one. Leave it empty for Ollama.</p>
          </div>
        </>
      )}
      <div className="ai-buttons">
        {usesEndpoint && (
          <button type="submit" disabled={busy || !edited || !valid}>
            Save
          </button>
        )}
        <button type="button" className="secondary" disabled={busy || !valid} onClick={() => void test()}>
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={saved.newCapturesOnly}
          disabled={busy}
          onChange={(event) => void save({ newCapturesOnly: event.target.checked })}
        />
        <span>
          <span className="choice-title">Only describe new captures</span>
          <span className="hint">Leave earlier captures alone. Turn it off to describe the whole library.</span>
        </span>
      </label>

      <div className="ai-buttons">
        {confirmingAll ? (
          <>
            <span className="hint">Describe every capture again, replacing the current descriptions?</span>
            <button type="button" disabled={busy} onClick={() => void describeAll()}>
              Re-describe all
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmingAll(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={busy || !saved.enabled}
            onClick={() => setConfirmingAll(true)}
          >
            Re-describe all…
          </button>
        )}
      </div>

      {/* Not role="status": the window's own status line is that. */}
      <p className={`ai-result ai-result-${result?.kind ?? "none"}`} aria-live="polite" data-testid="ai-result">
        {result?.message}
      </p>
    </form>
  );
}

export default AiSection;
