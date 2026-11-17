import { useEffect, useState } from "react";
import { agentSkillStatus, installAgentSkill, type AgentSkill } from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

interface Props {
  /** Whether the grab-it command line may capture. */
  access: boolean;
  disabled: boolean;
  /** Saves the access switch. */
  onAccess: (enabled: boolean) => void;
}

/** "~/.claude/skills/grab-it/SKILL.md" → "~/.claude/skills": where a copy went, as the hint names it. */
function skillsFolder(path: string): string {
  const parts = path.split(/[\\/]/);
  const index = parts.lastIndexOf("skills");
  if (index < 1) return path;
  return `~/${parts[index - 1]}/skills`;
}

/**
 * Settings › AI agents: lets agents such as Claude Code and Codex take
 * screenshots with the grab-it command line, and installs the skill that
 * teaches them its commands.
 */
function AgentsSection({ access, disabled, onAccess }: Props) {
  /** Null until read, or when it cannot be: the button still installs. */
  const [skill, setSkill] = useState<AgentSkill | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    agentSkillStatus()
      .then((status) => {
        if (!cancelled && status && Array.isArray(status.installed)) setSkill(status);
      })
      .catch(() => {
        // Without the status the button still installs.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function install() {
    setInstalling(true);
    setError(null);
    try {
      setSkill(await installAgentSkill());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setInstalling(false);
    }
  }

  const installed = skill !== null && skill.installed.length > 0;
  let skillHint: string;
  if (!installed) {
    skillHint = "Teaches Claude Code, Codex and other agents the grab-it commands. Installs into ~/.agents/skills and ~/.claude/skills.";
  } else if (skill?.current) {
    skillHint = `Installed in ${skill.installed.map(skillsFolder).join(" and ")}.`;
  } else {
    skillHint = "Installed for Grab-it in another place. Install it again so agents find this one.";
  }

  return (
    <section aria-labelledby="agents-heading">
      <h2 className="group-heading" id="agents-heading">
        Command line
      </h2>
      <div className="group">
        <label className="row">
          <span className="row-text">
            <span className="row-title">Let AI agents use Grab-it</span>
            <span className="row-hint">
              Agents and scripts can list your displays and windows and take screenshots with the grab-it command.
              Shots go to your Library tagged agent, and a notice shows each one.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={access}
            disabled={disabled}
            onChange={(event) => onAccess(event.target.checked)}
          />
        </label>
        <div className="row">
          <span className="row-text">
            <span className="row-title">Agent skill</span>
            <span className={error ? "row-hint ffmpeg-failed" : "row-hint"} aria-live="polite" data-testid="agent-skill">
              {error ?? skillHint}
            </span>
          </span>
          <button type="button" className="pill" onClick={() => void install()} disabled={installing}>
            {installing ? "Installing…" : installed && skill?.current ? "Reinstall skill" : "Install skill"}
          </button>
        </div>
      </div>
    </section>
  );
}

export default AgentsSection;
