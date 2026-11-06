"use client";
import SearchIcon from "@mui/icons-material/Search";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  listAdminIntegrations,
  listAdminOperations,
  listAdminServices,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAdminDraftAuthority } from "@/lib/admin/AdminDraftProvider";
import type { AdminNavigationAccess } from "@/lib/admin/adminNavigation";
import {
  type AdminSearchMetadata,
  buildAdminSearchEntries,
  searchAdminEntries,
} from "@/lib/admin/adminSearch";
import { useActivityClient } from "./activity/activityQueries";

export function AdminSearch({
  role,
  selfHosted,
  actorId,
}: AdminNavigationAccess & { actorId: string }) {
  const { apiUrl, client } = useActivityClient();
  const authority = useAdminDraftAuthority();
  const fullAdmin =
    role === "admin" &&
    (!authority.present ||
      (authority.owner?.role === "admin" &&
        authority.owner.actorId === actorId &&
        authority.owner.apiUrl === apiUrl));
  const t = useTranslations("adminNavigation");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const enabled = open && fullAdmin;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        fullAdmin &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [fullAdmin]);
  const scope = JSON.stringify([apiUrl, actorId, role, authority.generation]);
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, [scope]);
  const metadata = useQuery({
    queryKey: ["admin", "search", apiUrl, actorId, role, selfHosted, authority.generation],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled([
        (async () => {
          const response = await fetch(`${apiUrl}/api/admin/settings`, {
            credentials: "include",
            signal,
          });
          if (!response.ok) throw Error("Settings metadata unavailable");
          const data = (await response.json()) as {
            groups: { settings: NonNullable<AdminSearchMetadata["settings"]> }[];
          };
          return data.groups.flatMap((group) =>
            group.settings.map(({ key, group: groupId, subgroup, label, description }) => ({
              key,
              group: groupId,
              subgroup,
              label,
              description,
            })),
          );
        })(),
        selfHosted === false
          ? Promise.resolve([])
          : listAdminServices({ client, signal })
              .then(unwrapAdminResponse)
              .then((data) => data.services.map(({ id, name }) => ({ id, name }))),
        listAdminIntegrations({ client, signal })
          .then(unwrapAdminResponse)
          .then((data) => data.map(({ id, name }) => ({ id, name }))),
        listAdminOperations({ client, signal })
          .then(unwrapAdminResponse)
          .then((data) =>
            data.operations.map(({ id, title, description, fields }) => ({
              id,
              title,
              description,
              fields: fields.map(({ label }) => ({ label })),
            })),
          ),
      ]);
      const [settings, services, integrations, operations] = results;
      return {
        settings: settings.status === "fulfilled" ? settings.value : [],
        services: services.status === "fulfilled" ? services.value : [],
        integrations: integrations.status === "fulfilled" ? integrations.value : [],
        operations: operations.status === "fulfilled" ? operations.value : [],
        partial: results.some((result) => result.status === "rejected"),
      };
    },
  });
  const entries = useMemo(
    () =>
      buildAdminSearchEntries({ role, selfHosted }, metadata.data).map((entry) =>
        entry.id.includes(":") ||
        ["email-smtp", "transit-sources", "backup-retention", "release-selector"].includes(entry.id)
          ? entry
          : {
              ...entry,
              title: t(`destinations.${entry.id}.label`),
              description: t(`destinations.${entry.id}.description`),
            },
      ),
    [role, selfHosted, metadata.data, t],
  );
  const results = searchAdminEntries(entries, query);
  useEffect(() => {
    if (open)
      document.getElementById(`admin-search-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, selected]);
  const choose = (index: number) => {
    const entry = results[index];
    if (!entry) return;
    setOpen(false);
    router.push(entry.href);
  };
  if (!fullAdmin) return null;
  return (
    <>
      <Button
        startIcon={<SearchIcon />}
        size="small"
        aria-label={t("search")}
        onClick={() => {
          setQuery("");
          setSelected(0);
          setOpen(true);
        }}
        sx={{ minWidth: 36, "& .MuiButton-startIcon": { mr: { xs: 0, sm: 1 } } }}
      >
        <Typography component="span" variant="body2" sx={{ display: { xs: "none", sm: "inline" } }}>
          {t("search")}
        </Typography>
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
        slotProps={{ transition: { onEntered: () => input.current?.focus() } }}
      >
        <DialogTitle>{t("search")}</DialogTitle>
        <DialogContent sx={{ pt: "8px !important" }}>
          <TextField
            autoFocus
            fullWidth
            inputRef={input}
            value={query}
            label={t("searchPlaceholder")}
            slotProps={{
              htmlInput: {
                maxLength: 200,
                role: "combobox",
                "aria-expanded": true,
                "aria-controls": "admin-search-results",
                "aria-activedescendant": results[selected] ? `admin-search-${selected}` : undefined,
                "aria-autocomplete": "list",
              },
            }}
            onChange={(event) => {
              setQuery(event.target.value.slice(0, 200));
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) =>
                  Math.max(
                    0,
                    Math.min(results.length - 1, value + (event.key === "ArrowDown" ? 1 : -1)),
                  ),
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                choose(selected);
              }
            }}
          />
          {metadata.data?.partial && (
            <Alert
              severity="warning"
              action={<Button onClick={() => void metadata.refetch()}>{t("retry")}</Button>}
            >
              {t("partialSearch")}
            </Alert>
          )}
          <List
            id="admin-search-results"
            role="listbox"
            aria-label={t("searchResults")}
            sx={{ maxHeight: "55dvh", overflow: "auto" }}
          >
            {results.map((entry, index) => (
              <ListItemButton
                id={`admin-search-${index}`}
                key={entry.id}
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                selected={index === selected}
                onClick={() => choose(index)}
                onMouseMove={() => setSelected(index)}
              >
                <ListItemText primary={entry.title} secondary={entry.description} />
              </ListItemButton>
            ))}
          </List>
          {!results.length && (
            <Typography color="text.secondary">{t("noSearchResults")}</Typography>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
