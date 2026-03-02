"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useSearchStore } from "@openmapx/core";
import { useRef } from "react";
import { AutocompleteDropdown } from "./AutocompleteDropdown";

export function SearchBar() {
  const { query, isFocused, suggestions, setQuery, setIsFocused } = useSearchStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    // TODO Phase 3: trigger autocomplete fetch
  };

  const handleClear = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    inputRef.current?.blur();
    // TODO Phase 3: trigger geocoding search
  };

  return (
    <Box
      sx={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: 10,
        // Leave room for TopRightControls; don't right-anchor
        width: { xs: "calc(100% - 110px)", sm: "auto" },
      }}
    >
      <Paper
        component="form"
        onSubmit={handleSubmit}
        elevation={isFocused ? 4 : 2}
        sx={{
          display: "flex",
          alignItems: "center",
          height: 48,
          borderRadius: "24px",
          px: 0.5,
          transition: "box-shadow 0.2s",
          bgcolor: "background.paper",
          width: { xs: "100%", sm: 430 },
        }}
      >
        <IconButton size="small" sx={{ ml: 0.5, mr: 0.5 }} aria-label="Menu">
          <MenuIcon sx={{ fontSize: 22, color: "text.secondary" }} />
        </IconButton>

        <InputBase
          inputRef={inputRef}
          value={query}
          onChange={handleChange}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setTimeout(() => setIsFocused(false), 150)}
          placeholder="Search OpenMapX"
          inputProps={{ "aria-label": "search" }}
          sx={{
            flex: 1,
            fontSize: 16,
            "& input": {
              padding: 0,
              paddingLeft: "8px",
              "&::placeholder": { color: "text.secondary", opacity: 1 },
            },
          }}
        />

        {query.length > 0 && (
          <IconButton size="small" onClick={handleClear} aria-label="Clear search">
            <CloseIcon sx={{ fontSize: 18, color: "text.secondary" }} />
          </IconButton>
        )}

        <IconButton type="submit" size="small" aria-label="Search">
          <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
        </IconButton>

        {/* Divider + directions button inside the pill */}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
        <Tooltip title="Directions" placement="bottom">
          <IconButton size="small" aria-label="Get directions" sx={{ mr: 0.5 }}>
            <DirectionsIcon sx={{ fontSize: 22, color: "primary.main" }} />
          </IconButton>
        </Tooltip>
      </Paper>

      {/* Autocomplete dropdown — aligned under the pill */}
      <Box sx={{ position: "relative", width: { xs: "100%", sm: 430 } }}>
        {isFocused && suggestions.length > 0 && (
          <AutocompleteDropdown
            suggestions={suggestions}
            onSelect={(result) => {
              setQuery(result.label);
              setIsFocused(false);
              // TODO Phase 3: fly to result coordinates + open place panel
            }}
          />
        )}
      </Box>
    </Box>
  );
}
