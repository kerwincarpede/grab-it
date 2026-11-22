import { useEffect, useState, type FormEvent } from "react";
import { RefreshIcon } from "../app/icons";
import {
  AI_PROVIDERS,
  CLAUDE_MODELS,
  ENDPOINT_PRESETS,
  aiClis,
  aiCaptureCount,
  aiDescribes,
  aiProvider,
  destination,
  isLocalEndpoint,
  listModels,
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

interface Draft extends AiPreferences {
  endpoint: string;
  model: string;
  apiKey: string;
  claudeModel: string;
  codexModel: string;
}

const draftOf = (ai: AiPreferences): Draft => ({
  ...ai,
  endpoint: ai.endpoint,
  model: ai.model,
  apiKey: ai.apiKey ?? "",
  claudeModel: ai.claudeModel ?? "haiku",
  codexModel: ai.codexModel ?? "",
});

/**
 * What the user can change, as the backend saves it, so a draft that only
 * differs in spacing, a trailing slash or fields the backend owns (the
 * notice, where the key is kept) is not an edit.
 */
const editable = (draft: Draft) =>
  JSON.stringify([
    draft.enabled,
    draft.automaticDescriptions ?? true,
    aiProvider(draft),
    draft.endpoint.trim().replace(/\/+$/, ""),
    draft.model.trim(),
    draft.apiKey.trim(),
    draft.claudeModel.trim(),
    draft.codexModel.trim(),
    draft.newCapturesOnly,
    draft.tidyText,
  ]);

/** Where each provider sends screenshots. */
const PRIVACY: Record<AiProvider, string> = {
  claudeCode:
    "Claude Code sends your screenshots, with their text, app and window title, to Anthropic under your Claude account.",
  codex:
    "Codex sends your screenshots, with their text, app and window title, to OpenAI under your ChatGPT or OpenAI account.",
  endpoint:
    "With a local endpoint such as LM Studio or Ollama nothing leaves this computer; a cloud endpoint receives your screenshots.",
};

/**
 * Who describes and sorts captures. Everything here is a draft until Save,
 * and Cancel puts back what is saved. Test connection tries the draft
 * without saving it. A preset only fills in the endpoint's fields.
 */
function AiSection({ saved, disabled, onSave }: Props) {
  const [draft, updateDraft] = useState<Draft>(() => draftOf(saved));
  const [result, setResult] = useState<Result>(null);
  const [testing, setTesting] = useState(false);
  // Null until the backend has looked, or when it cannot say.
  const [clis, setClis] = useState<AiClis | null>(null);
  // What List models found at `endpoint`; forgotten when the endpoint changes.
  const [models, setModels] = useState<{ endpoint: string; ids: string[] } | null>(null);
  const [listing, setListing] = useState(false);

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

  const provider = aiProvider(draft);
  const usesEndpoint = provider === "endpoint";
  const typedValid = draft.endpoint.trim().length > 0 && draft.model.trim().length > 0;
  const edited = editable(draft) !== editable(draftOf(saved));
  const valid = !usesEndpoint || typedValid;
  const busy = disabled || testing || listing;
  // The chosen CLI provider's name and command, when Grab-it looked and could not find it.
  const missing =
    clis === null
      ? null
      : provider === "claudeCode" && clis.claudeCode === null
        ? { name: "Claude Code", command: "claude" }
        : provider === "codex" && clis.codex === null
          ? { name: "Codex", command: "codex" }
          : null;

  const [confirmation, setConfirmation] = useState<{ count: number; action: "save" | "describe" } | null>(null);

  function setDraft(next: Draft) {
    setConfirmation(null);
    updateDraft(next);
  }

  function preferences(): AiPreferences {
    return {
      ...draft,
      endpoint: draft.endpoint.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim() || null,
    };
  }

  async function save() {
    setConfirmation(null);
    const next = preferences();
    if (await onSave(next)) setDraft(draftOf(next));
  }

  async function confirmCount(action: "save" | "describe") {
    try {
      // A save only sends what is still waiting; Re-describe all sends everything.
      const count = await aiCaptureCount(action === "save");
      setConfirmation({ count, action });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !edited) return;
    if (draft.enabled && (draft.automaticDescriptions ?? true) && !draft.newCapturesOnly &&
      (!saved.enabled || saved.automaticDescriptions === false || saved.newCapturesOnly)) {
      void confirmCount("save");
    } else {
      void save();
    }
  }

  async function test() {
    setResult(null);
    setTesting(true);
    try {
      const info = await testAiConnection(preferences());
      setResult({ kind: "ok", message: info ? `Connected: ${info}` : "Connected." });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  async function describeAll() {
    setConfirmation(null);
    setResult(null);
    try {
      await redescribeAll();
      setResult({ kind: "info", message: "Describing every capture again. The Library shows the progress." });
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    }
  }

  const local = usesEndpoint && isLocalEndpoint(draft.endpoint.trim());
  // The menu follows the URL, so typing your own shows "Custom"; any model ID keeps the preset.
  const preset = matchingPreset(draft.endpoint);
  const endpointKey = draft.endpoint.trim().replace(/\/+$/, "");
  const listed = models?.endpoint === endpointKey ? models.ids : null;

  function choosePreset(id: string) {
    const chosen = ENDPOINT_PRESETS.find((candidate) => candidate.id === id);
    if (!chosen) return;
    setResult(null);
    // A key belongs to the server it was typed for, so another server starts without one.
    setDraft({ ...draft, apiKey: chosen.endpoint === endpointKey ? draft.apiKey : "", endpoint: chosen.endpoint, model: chosen.model });
  }

  async function findModels() {
    setResult(null);
    setListing(true);
    try {
      const ids = await listModels(endpointKey, draft.apiKey.trim() || null);
      setModels({ endpoint: endpointKey, ids });
      setResult(
        ids.length === 0
          ? { kind: "info", message: "The server lists no models. Type the model's ID instead." }
          : { kind: "info", message: `Found ${ids.length} ${ids.length === 1 ? "model" : "models"}. Choose one that accepts images under Listed models, or type its ID.` },
      );
    } catch (err) {
      setResult({ kind: "error", message: errorMessage(err) });
    } finally {
      setListing(false);
    }
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
            <span className="row-title">Use an AI provider</span>
            <span className="row-hint">
              A vision model writes a short description, picks a category and adds up to three short tags, so you can search
              for what is in a capture.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={draft.enabled}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked, provider, ...(saved.provider == null && !saved.enabled ? { automaticDescriptions: false, tidyText: false } : {}) })}
          />
        </label>
        <label className="row">
          <span className="row-text"><span className="row-title">Describe captures with AI</span></span>
          <input type="checkbox" role="switch" className="switch"
            checked={draft.enabled && (draft.automaticDescriptions ?? true)} disabled={busy || !draft.enabled}
            onChange={(event) => setDraft({ ...draft, automaticDescriptions: event.target.checked })} />
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
            checked={draft.newCapturesOnly}
            // Only matters while captures are described.
            disabled={busy || !aiDescribes(draft)}
            onChange={(event) => setDraft({ ...draft, newCapturesOnly: event.target.checked })}
          />
        </label>
        <label className="row">
          <span className="row-text">
            <span className="row-title">Tidy up captured text</span>
            <span className="row-hint">
              After Capture text, the AI reads the text again from the image, fixes what was misread, and lays out JSON,
              code and tables properly. The tidied text replaces what was copied.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={draft.tidyText}
            disabled={busy || !draft.enabled}
            onChange={(event) => setDraft({ ...draft, tidyText: event.target.checked })}
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
                    setDraft({ ...draft, provider: choice.value });
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

        {provider === "claudeCode" && (
          <div className="row">
            <span className="row-text">
              <label className="row-title" htmlFor="ai-cli-model">
                Model
              </label>
              <span className="row-hint">
                Haiku is the fastest and cheapest; sonnet and opus write more detail. A full model name works too.
              </span>
            </span>
            <input
              id="ai-cli-model"
              className="row-field"
              type="text"
              list="ai-claude-models"
              spellCheck={false}
              autoComplete="off"
              value={draft.claudeModel}
              disabled={busy}
              placeholder="haiku"
              onChange={(event) => setDraft({ ...draft, claudeModel: event.target.value })}
            />
            <datalist id="ai-claude-models">
              {CLAUDE_MODELS.map((choice) => (
                <option key={choice.value} value={choice.value} label={choice.hint} />
              ))}
            </datalist>
          </div>
        )}
        {provider === "codex" && (
          <div className="row">
            <span className="row-text">
              <label className="row-title" htmlFor="ai-cli-model">
                Model
              </label>
              <span className="row-hint">Leave it empty to use the model set up in Codex itself.</span>
            </span>
            <input
              id="ai-cli-model"
              className="row-field"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={draft.codexModel}
              disabled={busy}
              placeholder="Codex default"
              onChange={(event) => setDraft({ ...draft, codexModel: event.target.value })}
            />
          </div>
        )}

        {usesEndpoint && (
          <>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-preset">
                  Preset
                </label>
                <span className="row-hint" data-testid="ai-setup">
                  {preset ? preset.setup : "Your own OpenAI-compatible server. Fill in its URL and a vision model below."}
                </span>
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
                onChange={(event) => setDraft({ ...draft, apiKey: "", endpoint: event.target.value })}
              />
            </div>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-model">
                  Model
                </label>
                <span className="row-hint">It must accept images. Type its ID, or list what the server offers.</span>
              </span>
              <span className="row-control">
                <span className="row-field row-field-with-action">
                  <input
                    id="ai-model"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={draft.model}
                    disabled={busy}
                    placeholder={preset?.model ?? "qwen3-vl:4b"}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  />
                  {(preset?.listsModels ?? true) && (
                    <button
                      type="button"
                      className="pill icon-only"
                      aria-label="List models"
                      title="List models"
                      aria-busy={listing}
                      disabled={busy || endpointKey.length === 0}
                      onClick={() => void findModels()}
                    >
                      {listing ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon size={15} />}
                    </button>
                  )}
                </span>
              </span>
            </div>
            {listed && listed.length > 0 && (
              <div className="row">
                <span className="row-text">
                  <label className="row-title" htmlFor="ai-listed-models">
                    Listed models
                  </label>
                  <span className="row-hint">What the server offers. Choosing one fills in Model.</span>
                </span>
                {/* A menu, not a datalist: a datalist hides every ID that does not start with what Model holds. */}
                <select
                  id="ai-listed-models"
                  className="row-field"
                  value={listed.includes(draft.model.trim()) ? draft.model.trim() : ""}
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value) setDraft({ ...draft, model: event.target.value });
                  }}
                >
                  <option value="">Choose a model…</option>
                  {listed.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="ai-api-key">
                  API key
                </label>
                <span className="row-hint" data-testid="ai-api-key-hint">
                  Only cloud providers need one. Leave it empty for LM Studio and Ollama.{" "}
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
          <p className="hint ai-destination" data-testid="ai-destination">
            Test connection sends a small sample image, not one of your captures, to{" "}
            {destination(draft) || "the endpoint"}. It checks that the server answers, takes a request with an image, and replies with the JSON asked for. It cannot tell whether the model looked at the image.
          </p>
        </div>
        <div className="row">
          {/* Not role="status": the window's own status line is that. */}
          <p className={`ai-result ai-result-${result?.kind ?? "none"}`} aria-live="polite" data-testid="ai-result">
            {result?.message}
          </p>
          <span className="row-control">
            <button type="button" className="pill" disabled={busy || !valid} onClick={() => void test()}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            {edited && <button type="button" className="pill" disabled={busy} onClick={() => { setDraft(draftOf(saved)); setConfirmation(null); setResult(null); }}>Cancel</button>}
            <button type="submit" className="pill is-primary" disabled={busy || !edited || !valid}>
              Save
            </button>
          </span>
        </div>
      </div>

      <h2 className="group-heading">Your library</h2>
      <div className="group">
        <div className="row">
          {confirmation ? (
            <>
              <span className="row-text">
                <span className="row-title">Describe {confirmation.count} screenshots?</span>
                <span className="row-hint">
                  {confirmation.action === "save"
                    ? "Earlier captures not yet described are sent to the provider."
                    : "This replaces the current descriptions."}
                </span>
              </span>
              <span className="row-control">
                <button type="button" className="pill" onClick={() => setConfirmation(null)}>
                  Cancel
                </button>
                <button type="button" className="pill is-primary" disabled={busy} onClick={() => void (confirmation.action === "save" ? save() : describeAll())}>
                  {confirmation.action === "save" ? "Confirm and save" : "Re-describe all"}
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
                disabled={busy || !aiDescribes(saved)}
                onClick={() => void confirmCount("describe")}
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
