import type { Shape } from "./model";

interface AiAnnotatePanelProps {
  /** What the user asked for; kept while Settings is open and after suggestions come back. */
  prompt: string;
  onPrompt: (prompt: string) => void;
  /** The provider is working on it. */
  busy: boolean;
  /** No provider is set up yet: the panel offers Settings, keeping the request. */
  needsProvider: boolean;
  /** How the last request went, or why it failed. */
  message: string | null;
  /** The suggestions on preview, not yet in the document; null before any came back. */
  suggestions: Shape[] | null;
  onSuggest: () => void;
  onCancel: () => void;
  /** Adds every suggestion on preview as one undo step. */
  onApply: () => void;
  onDiscard: (id: string) => void;
  onDiscardAll: () => void;
  onOpenSettings: () => void;
}

function describe(shape: Shape): string {
  switch (shape.type) {
    case "rect":
      return "Box";
    case "arrow":
      return "Arrow";
    case "text":
      return `Label “${shape.text}”`;
    default:
      return "Shape";
  }
}

/**
 * The Annotate with AI popover: a request in the user's words, then the
 * suggested shapes, previewed on the canvas until they are applied or
 * discarded.
 */
export default function AiAnnotatePanel(props: AiAnnotatePanelProps) {
  const { prompt, busy, needsProvider, message, suggestions } = props;
  const canSuggest = !busy && prompt.trim() !== "";
  return (
    <div className="backdrop-panel ai-annotate-panel" role="dialog" aria-label="Annotate with AI">
      <label className="ai-annotate-field">
        <span>Describe the markup</span>
        <textarea
          value={prompt}
          rows={3}
          aria-label="Describe the markup"
          placeholder="Box the provider controls, point an arrow at Test connection and label it"
          onChange={(event) => props.onPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSuggest) props.onSuggest();
          }}
        />
      </label>
      <div className="ai-annotate-actions">
        {busy ? (
          <button type="button" className="text-button" onClick={props.onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="text-button primary" disabled={!canSuggest} onClick={props.onSuggest}>
            Suggest
          </button>
        )}
        {busy && (
          <span className="ai-annotate-status" role="status">
            Asking your AI provider…
          </span>
        )}
      </div>
      {needsProvider && (
        <div className="ai-annotate-setup" role="status">
          <p>Choose an AI provider first. Your request and this capture stay here while you set it up.</p>
          <button type="button" className="text-button" onClick={props.onOpenSettings}>
            Open AI integration
          </button>
        </div>
      )}
      {message && !busy && (
        <p className="resize-note" role="status">
          {message}
        </p>
      )}
      {suggestions && suggestions.length > 0 && (
        <>
          <ul className="ai-annotate-list" aria-label="Suggestions">
            {suggestions.map((shape) => (
              <li key={shape.id}>
                <span>{describe(shape)}</span>
                <button type="button" className="icon-button" aria-label={`Discard ${describe(shape)}`} onClick={() => props.onDiscard(shape.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="ai-annotate-actions">
            <button type="button" className="text-button primary" onClick={props.onApply}>
              Apply {suggestions.length === 1 ? "suggestion" : `${suggestions.length} suggestions`}
            </button>
            <button type="button" className="text-button" onClick={props.onDiscardAll}>
              Discard
            </button>
          </div>
        </>
      )}
      <p className="resize-note">
        Sends the capture without your edits, the text Grab-it read in it with its positions, and your request to the provider
        chosen in Settings.
      </p>
    </div>
  );
}
