// Turbopack requires at least one file matching the dynamic import glob pattern
// `@integrations/${id}/panel`. This placeholder satisfies that requirement.
// It is never loaded at runtime — only integrations with `frontend.panel`
// in their manifest are mounted by PanelHost.
export default function Placeholder() {
  return null;
}
