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

  const chosen = AI_PROVIDERS.find((choice) => choice.value === provider);

  return (
    <form className="ai-settings" aria-labelledby="ai-heading" onSubmit={submit}>
      <h2 className="group-heading" id="ai-heading">
        Describing captures
      </h2>
      <div className="group">
        <label className="row">
          <span className="row-text">
            <span className="row-title">Describe captures with AI</span>
            <span className="row-hint">
              A vision model writes a short description, picks a category and adds up to three short tags, so you can search
              for what is in a capture.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={saved.enabled}
            disabled={busy}
            onChange={(event) => void save({ enabled: event.target.checked })}
          />
        </label>
        <label className="row">
          <span className="row-text">
            <span className="row-title">Only describe new captures</span>
            <span className="row-hint">Leave earlier captures alone. Turn it off to describe the whole library.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={saved.newCapturesOnly}
            disabled={busy}
            onChange={(event) => void save({ newCapturesOnly: event.target.checked })}
          />
        </label>
      </div>

      <h2 className="group-heading" id="ai-provider-heading">
        Described by
      </h2>
      <div className="group">
        <div className="row is-stacked">
          <fieldset className="segmented ai-providers" aria-labelledby="ai-provider-heading" disabled={busy}>
            {AI_PROVIDERS.map((choice) => (
              <label key={choice.value}>
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
                {choice.title}
              </label>
            ))}
          </fieldset>
          {chosen && <span className="row-hint">{chosen.hint}</span>}
          {missing && (
            <p className="hint ai-missing" data-testid="ai-missing">
              Grab-it cannot find {missing.name}: there is no {missing.command} command on this computer. Install{" "}
              {missing.name} and sign in, then reopen Settings, or choose another provider instead.
            </p>
          )}
          <p className={`hint ai-privacy${local ? "" : " ai-privacy-cloud"}`}>{PRIVACY[provider]}</p>
        </div>

        {usesEndpoint && (
          <>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-preset">
                  Preset
                </label>
                <span className="row-hint">Fills in the URL and a model. Cloud providers also need your API key.</span>
              </span>
              <select
                id="ai-preset"
                className="row-field"
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
            </div>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-endpoint">
                  Endpoint URL
                </label>
                <span className="row-hint">Any OpenAI-compatible API, such as Ollama, LM Studio or a cloud provider.</span>
              </span>
              <input
                id="ai-endpoint"
                className="row-field"
                type="text"
                inputMode="url"
                spellCheck={false}
                value={draft.endpoint}
                disabled={busy}
                placeholder="http://localhost:11434/v1"
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              />
            </div>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-model">
                  Model
                </label>
                <span className="row-hint">It must accept images.</span>
              </span>
              <input
                id="ai-model"
                className="row-field"
                type="text"
                spellCheck={false}
                value={draft.model}
                disabled={busy}
                placeholder="qwen3-vl:4b"
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
            </div>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-api-key">
                  API key
                </label>
                <span className="row-hint" data-testid="ai-api-key-hint">
                  Only cloud providers need one. Leave it empty for Ollama.{" "}
                  {saved.apiKeyStorage === "keychain"
                    ? "It is kept in your system keychain, not in Grab-it's settings file."
                    : "This computer has no keychain Grab-it can use, so it is kept in plain text in Grab-it's settings file."}
                </span>
              </span>
              <input
                id="ai-api-key"
                className="row-field"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                disabled={busy}
                placeholder="Optional"
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
            </div>
          </>
        )}
        <div className="row">
          {/* Not role="status": the window's own status line is that. */}
          <p className={`ai-result ai-result-${result?.kind ?? "none"}`} aria-live="polite" data-testid="ai-result">
            {result?.message}
          </p>
          <span className="row-control">
            <button type="button" className="pill" disabled={busy || !valid} onClick={() => void test()}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            {usesEndpoint && (
              <button type="submit" className="pill is-primary" disabled={busy || !edited || !valid}>
                Save
              </button>
            )}
          </span>
        </div>
      </div>

      <h2 className="group-heading">Your library</h2>
      <div className="group">
        <div className="row">
          {confirmingAll ? (
            <>
              <span className="row-text">
                <span className="row-title">Describe every capture again?</span>
                <span className="row-hint">This replaces the current descriptions.</span>
              </span>
              <span className="row-control">
                <button type="button" className="pill" onClick={() => setConfirmingAll(false)}>
                  Cancel
                </button>
                <button type="button" className="pill is-primary" disabled={busy} onClick={() => void describeAll()}>
                  Re-describe all
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="row-text">
                <span className="row-title">Describe everything again</span>
                <span className="row-hint">Useful after switching to a better model.</span>
              </span>
              <button
                type="button"
                className="pill"
                disabled={busy || !saved.enabled}
                onClick={() => setConfirmingAll(true)}
              >
                Re-describe all…
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}

export default AiSection;
