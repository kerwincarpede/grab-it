import type { ReactNode } from "react";
import Dialog from "./Dialog";
import { AppearanceIcon, CloseIcon, KeyboardIcon, PenIcon, RecordIcon, RegionIcon, SlidersIcon, SparkleIcon } from "./icons";
import SettingsWindow from "../settings/SettingsWindow";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings/api";

const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  general: <SlidersIcon />,
  appearance: <AppearanceIcon />,
  capture: <RegionIcon />,
  editor: <PenIcon />,
  recording: <RecordIcon />,
  ai: <SparkleIcon />,
  hotkeys: <KeyboardIcon />,
};

interface SettingsDialogProps {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}

/** Settings over the Grab-it window: its pages down the left, one at a time. */
function SettingsDialog({ section, onSection, onClose }: SettingsDialogProps) {
  return (
    <Dialog title="Settings" hideTitle className="settings-dialog" onClose={onClose}>
      <nav className="settings-nav" aria-label="Settings pages">
        <p className="settings-nav-title" aria-hidden="true">
          Settings
        </p>
        {SETTINGS_SECTIONS.map(({ id, title }) => (
          <button
            key={id}
            type="button"
            className={`nav-item${id === section ? " is-current" : ""}`}
            aria-current={id === section ? "page" : undefined}
            onClick={() => onSection(id)}
          >
            {SECTION_ICONS[id]}
            <span className="nav-label">{title}</span>
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <button type="button" className="icon-button dialog-close" aria-label="Close Settings" onClick={onClose}>
          <CloseIcon size={15} />
        </button>
        <SettingsWindow key={section} section={section} />
      </div>
    </Dialog>
  );
}

export default SettingsDialog;
