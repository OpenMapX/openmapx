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
