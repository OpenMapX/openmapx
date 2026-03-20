"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import { useCallback, useEffect, useRef, useState } from "react";

export interface LegalSection {
  id: string;
  label: string;
}

interface Props {
  sections: LegalSection[];
  children: React.ReactNode;
}

export function LegalPageShell({ sections, children }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const container = contentRef.current;
    if (!container || sections.length === 0) return;

    const handleScroll = () => {
      let current = sections[0]?.id ?? "";
      for (const s of sections) {
        const el = container.querySelector(`#${CSS.escape(s.id)}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (rect.top - containerRect.top <= 80) current = s.id;
      }
      setActiveId(current);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener("scroll", handleScroll);
  }, [sections]);

  // Handle hash navigation (e.g. /terms#data-sources)
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    requestAnimationFrame(() => {
      const el = contentRef.current?.querySelector(`#${CSS.escape(hash)}`);
      if (el) el.scrollIntoView({ block: "start" });
    });
  }, []);

  const handleClick = useCallback(
    (id: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveId(id);
        window.history.replaceState(null, "", `#${id}`);
      }
    },
    [],
  );

  return (
    <Box sx={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Sidebar */}
      <Box
        component="nav"
        sx={{
          width: 260,
          flexShrink: 0,
          overflowY: "auto",
          py: 2,
          pl: 3,
          pr: 1,
          borderRight: 1,
          borderColor: "divider",
          display: { xs: "none", md: "block" },
        }}
      >
        {sections.map((s) => (
          <Link
            key={s.id}
            href={`#${s.id}`}
            onClick={handleClick(s.id)}
            sx={{
              display: "block",
              py: 0.6,
              px: 1,
              fontSize: "13px",
              lineHeight: 1.4,
              color: activeId === s.id ? "primary.main" : "text.primary",
              fontWeight: activeId === s.id ? 600 : 400,
              textDecoration: "none",
              borderRadius: 1,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            {s.label}
          </Link>
        ))}
      </Box>

      {/* Content */}
      <Box
        ref={contentRef}
        sx={{
          flex: 1,
          overflowY: "auto",
          px: { xs: 2, sm: 4, md: 6 },
          py: 4,
        }}
      >
        <Box sx={{ maxWidth: 820 }}>{children}</Box>
      </Box>
    </Box>
  );
}
