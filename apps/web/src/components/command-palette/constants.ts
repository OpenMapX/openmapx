/**
 * Stable DOM identifiers shared between the command palette, the global
 * keybindings listener, and the SearchBar. These must NOT depend on
 * localised aria-labels or placeholders.
 */

/** id assigned to the SearchBar's `<input>` so the palette and "/" handler
 * can reliably focus it across locales. */
export const SEARCH_INPUT_ID = "openmapx-search-input";

/** id assigned to the listbox the palette renders, used by the input's
 * `aria-controls` for combobox/listbox semantics. */
export const COMMAND_PALETTE_LISTBOX_ID = "command-palette-listbox";

/** Window event dispatched by the "Open layer selector" command and listened
 * for by `LayerSelector.tsx` to programmatically open the full Map Details
 * popover. */
export const LAYER_SELECTOR_OPEN_EVENT = "openmapx:open-layer-selector";
