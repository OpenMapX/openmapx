"use client";

import AddIcon from "@mui/icons-material/Add";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import LockResetIcon from "@mui/icons-material/LockReset";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import SecurityIcon from "@mui/icons-material/Security";
import SupervisorAccountIcon from "@mui/icons-material/SupervisorAccount";
import VerifiedIcon from "@mui/icons-material/Verified";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableSortLabel from "@mui/material/TableSortLabel";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { getInitials, proxyImageUrl } from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import Menu from "@/components/ui/Menu";
import { useAdminDraftExit } from "@/lib/admin/AdminDraftProvider";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { useAccountErrorText } from "@/lib/admin/useAccountErrorText";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSkeleton } from "../shared/TableSkeleton";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useServerPagination } from "../shared/tableHooks";
import { BanUserDialog } from "./BanUserDialog";
import { CreateUserDialog } from "./CreateUserDialog";

type FilterTab = "all" | "active" | "banned" | "admins";
type SortField = "name" | "email" | "createdAt";
type SortDir = "asc" | "desc";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  twoFactorEnabled?: boolean | null;
  createdAt: Date | string;
  updatedAt: string;
}

function UserRoleSelect({
  userId,
  role,
  isSelf,
}: {
  userId: string;
  role?: string | null;
  isSelf: boolean;
}) {
  const t = useTranslations("adminUsers");
  const showToast = useAdminToast();
  const errorText = useAccountErrorText();
  const mutation = useAccountAction(userId, {
    onError: (error) => showToast(errorText(error), "error"),
  });

  return (
    <FormControl size="small" sx={{ minWidth: 90 }}>
      <Select
        inputProps={{ "aria-label": t("role") }}
        value={role ?? "user"}
        disabled={isSelf || mutation.isPending}
        onChange={(e) => {
          const next = e.target.value;
          mutation.mutate((client) => client.changeRole(userId, next, role ?? "user"));
        }}
        variant="standard"
        disableUnderline
        sx={{ fontSize: 13 }}
      >
        <MenuItem value="user">{t("user")}</MenuItem>
        <MenuItem value="admin">{t("admin")}</MenuItem>
      </Select>
    </FormControl>
  );
}

function ActionsMenu({
  user,
  isSelf,
  isLastAdmin,
  onBan,
  impersonate,
  impersonating,
}: {
  user: AdminUser;
  isSelf: boolean;
  isLastAdmin: boolean;
  onBan: (user: AdminUser) => void;
  impersonate: (id: string) => void;
  impersonating: boolean;
}) {
  const t = useTranslations("adminUsers");
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showToast = useAdminToast();
  const errorText = useAccountErrorText();

  const unban = useAccountAction(user.id, {
    onSuccess: () => {
      setAnchor(null);
      showToast(t("nameUnbanned", { name: user.name }));
    },
    onError: (error) => showToast(errorText(error), "error"),
  });
  const deleteUser = useAccountAction(user.id, {
    onSuccess: () => {
      setConfirmDelete(false);
      setAnchor(null);
      showToast(t("nameDeleted", { name: user.name }));
    },
    onError: (error) => showToast(errorText(error), "error"),
  });

  return (
    <>
      <IconButton
        size="small"
        aria-label={t("userActions")}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <MenuItem component={Link} href={`/admin/users/${user.id}`} onClick={() => setAnchor(null)}>
          <ListItemIcon>
            <PersonSearchIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("view")}</ListItemText>
        </MenuItem>
        {!isSelf && (
          <MenuItem onClick={() => impersonate(user.id)} disabled={impersonating}>
            <ListItemIcon>
              <SupervisorAccountIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("impersonate")}</ListItemText>
          </MenuItem>
        )}
        {user.banned ? (
          <MenuItem
            onClick={() => unban.mutate((client) => client.unban(user.id))}
            disabled={unban.isPending}
          >
            <ListItemIcon>
              <CheckCircleIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("unban")}</ListItemText>
          </MenuItem>
        ) : (
          !isSelf && (
            <MenuItem
              onClick={() => {
                setAnchor(null);
                onBan(user);
              }}
            >
              <ListItemIcon>
                <BlockIcon fontSize="small" color="warning" />
              </ListItemIcon>
              <ListItemText>{t("ban")}</ListItemText>
            </MenuItem>
          )
        )}
        <MenuItem
          component={Link}
          href={`/admin/users/${user.id}#account-recovery`}
          onClick={() => setAnchor(null)}
        >
          <ListItemIcon>
            <LockResetIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("accountRecoveryMenuItem")}</ListItemText>
        </MenuItem>
        {!isSelf && !isLastAdmin && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              setConfirmDelete(true);
            }}
            sx={{ color: "error.main" }}
          >
            <ListItemIcon>
              <DeleteIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>{t("delete")}</ListItemText>
          </MenuItem>
        )}
      </Menu>
      <ConfirmDialog
        open={confirmDelete}
        title={t("deleteUser")}
        message={t("permanentlyDeleteNameEmailThis", { name: user.name, email: user.email })}
        confirmLabel={t("delete")}
        confirmColor="error"
        loading={deleteUser.isPending}
        onConfirm={() => deleteUser.mutate((client) => client.remove(user.id))}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

export function UserList() {
  const t = useTranslations("adminUsers");
  const format = useAdminFormat();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterTab>("all");
  const { page, rowsPerPage, offset, setPage, paginationProps } = useServerPagination(25);
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [createOpen, setCreateOpen] = useState(false);
  const [impersonationTarget, setImpersonationTarget] = useState("");
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);

  const account = useAccountAdmin();
  const currentUserId = account.actorId;

  const {
    data,
    isLoading,
    error: readError,
  } = useQuery({
    queryKey: account.keys.list({ search, filter, page, rowsPerPage, sortField, sortDir }),
    enabled: Boolean(account.actorId),
    retry: false,
    queryFn: async ({ signal }) => {
      const filterMap: Record<FilterTab, Record<string, string>> = {
        all: {},
        active: { filterField: "banned", filterValue: "false", filterOperator: "eq" },
        banned: { filterField: "banned", filterValue: "true", filterOperator: "eq" },
        admins: { filterField: "role", filterValue: "admin", filterOperator: "eq" },
      };

      const result = await account.client.list(
        {
          ...(search
            ? { searchValue: search, searchField: "email", searchOperator: "contains" }
            : {}),
          ...filterMap[filter],
          limit: rowsPerPage,
          offset,
          sortBy: sortField,
          sortDirection: sortDir,
        },
        signal,
      );

      return result;
    },
  });

  const users: AdminUser[] = (data?.users as unknown as AdminUser[]) ?? [];
  const total: number = (data as { total?: number } | null)?.total ?? users.length;

  // Fetch total admin count across all pages for last-admin protection
  const { data: adminData, error: countError } = useQuery({
    queryKey: account.keys.count,
    enabled: Boolean(account.actorId),
    retry: false,
    queryFn: ({ signal }) => account.client.count(signal),
    staleTime: 30000,
  });
  const adminCount = adminData;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setPage(0);
  };

  const handleFilterChange = (_: React.MouseEvent<HTMLElement>, val: FilterTab | null) => {
    if (val) {
      setFilter(val);
      setPage(0);
    }
  };

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <AdminPageHeader
        title={t("users")}
        subtitle={t("accountsRolesBansImpersonation")}
        actions={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            size="small"
          >
            {t("createUserTitle")}
          </Button>
        }
      />
      {readError && (
        <Alert severity="error">
          {data ? t("couldNotLoadAccountsShowingLast") : t("couldNotLoadAccounts")}
        </Alert>
      )}
      {countError && !readError && (
        <Alert severity="warning">{t("administratorCountIsTemporarilyUnavailable")}</Alert>
      )}
      <AdminTableSurface
        toolbar={
          <TableToolbar>
            <TableSearchField
              placeholder={t("searchUsersByEmail")}
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              minWidth={280}
            />
            <ToggleButtonGroup size="small" exclusive value={filter} onChange={handleFilterChange}>
              <ToggleButton value="all">{t("all")}</ToggleButton>
              <ToggleButton value="active">{t("active")}</ToggleButton>
              <ToggleButton value="banned">{t("banned")}</ToggleButton>
              <ToggleButton value="admins">{t("admins")}</ToggleButton>
            </ToggleButtonGroup>
          </TableToolbar>
        }
        pagination={
          <AdminTablePagination
            {...paginationProps}
            count={total}
            rowsPerPageOptions={[25, 50, 100]}
            hideSinglePage={false}
          />
        }
      >
        <TableContainer>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 48 }} />
                <TableCell>
                  <TableSortLabel
                    active={sortField === "name"}
                    direction={sortField === "name" ? sortDir : "asc"}
                    onClick={() => handleSort("name")}
                  >
                    {t("name")}
                  </TableSortLabel>
                </TableCell>
                <TableCell>
                  <TableSortLabel
                    active={sortField === "email"}
                    direction={sortField === "email" ? sortDir : "asc"}
                    onClick={() => handleSort("email")}
                  >
                    {t("email")}
                  </TableSortLabel>
                </TableCell>
                <TableCell>{t("role")}</TableCell>
                <TableCell>{t("status")}</TableCell>
                <TableCell sx={{ width: 40 }}>{t("twoFactorColumn")}</TableCell>
                <TableCell>
                  <TableSortLabel
                    active={sortField === "createdAt"}
                    direction={sortField === "createdAt" ? sortDir : "asc"}
                    onClick={() => handleSort("createdAt")}
                  >
                    {t("joinedColumn")}
                  </TableSortLabel>
                </TableCell>
                <TableCell sx={{ width: 48 }} />
              </TableRow>
            </TableHead>
            {isLoading ? (
              <TableSkeleton rows={6} columns={8} />
            ) : (
              <TableBody>
                {users.length === 0 ? (
                  <TableEmptyState
                    colSpan={8}
                    message={readError ? t("unableToLoadAccounts") : t("noUsersFound")}
                  />
                ) : (
                  users.map((user) => {
                    const isSelf = user.id === currentUserId;
                    const isLastAdmin = user.role === "admin" && adminCount === 1;
                    const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;
                    return (
                      <TableRow key={user.id} hover>
                        <TableCell sx={{ pr: 0 }}>
                          <Avatar
                            src={avatarSrc}
                            alt={user.name}
                            sx={{ width: 28, height: 28, fontSize: 11, bgcolor: "primary.main" }}
                          >
                            {!user.image && getInitials(user.name, user.email)}
                          </Avatar>
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            component="div"
                            sx={{
                              fontWeight: 500,
                            }}
                          >
                            {user.name}
                            {isSelf && (
                              <Chip
                                label={t("you")}
                                size="small"
                                sx={{ ml: 0.5, height: 16, fontSize: 10 }}
                              />
                            )}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Stack
                            direction="row"
                            sx={{
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Typography variant="body2">{user.email}</Typography>
                            {user.emailVerified && (
                              <Tooltip title={t("emailVerifiedTooltip")}>
                                <VerifiedIcon sx={{ fontSize: 14, color: "success.main" }} />
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <UserRoleSelect
                            userId={user.id}
                            role={user.role}
                            isSelf={isSelf || isLastAdmin}
                          />
                        </TableCell>
                        <TableCell>
                          {user.banned ? (
                            <Tooltip title={user.banReason ?? t("banned")}>
                              <Chip
                                label={t("banned")}
                                size="small"
                                color="error"
                                variant="outlined"
                              />
                            </Tooltip>
                          ) : user.emailVerified ? (
                            <Chip
                              label={t("active")}
                              size="small"
                              color="success"
                              variant="outlined"
                            />
                          ) : (
                            <Chip label={t("unverified")} size="small" variant="outlined" />
                          )}
                        </TableCell>
                        <TableCell>
                          {user.twoFactorEnabled && (
                            <Tooltip title={t("n2faEnabled")}>
                              <SecurityIcon sx={{ fontSize: 16, color: "primary.main" }} />
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            sx={{
                              color: "text.secondary",
                            }}
                          >
                            {format.date(user.createdAt)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <ActionsMenu
                            user={user}
                            isSelf={isSelf}
                            isLastAdmin={isLastAdmin}
                            onBan={setBanTarget}
                            impersonate={setImpersonationTarget}
                            impersonating={Boolean(impersonationTarget)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            )}
          </Table>
        </TableContainer>
      </AdminTableSurface>
      {impersonationTarget && (
        <ImpersonationAction
          key={impersonationTarget}
          targetId={impersonationTarget}
          onDone={() => setImpersonationTarget("")}
        />
      )}
      <CreateUserDialog
        key={`${account.apiUrl}:${account.actorId}`}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      {banTarget && (
        <BanUserDialog
          key={`${account.apiUrl}:${account.actorId}:${banTarget.id}`}
          user={banTarget}
          onClose={() => setBanTarget(null)}
        />
      )}
    </Stack>
  );
}

function ImpersonationAction({ targetId, onDone }: { targetId: string; onDone: () => void }) {
  const t = useTranslations("adminUsers");
  const requestExit = useAdminDraftExit();
  const router = useRouter(),
    showToast = useAdminToast(),
    errorText = useAccountErrorText();
  const action = useAccountAction(targetId, {
    impersonation: true,
    onSuccess: () => {
      router.push("/");
      router.refresh();
      onDone();
    },
    onError: (error) => {
      showToast(errorText(error), "error");
      onDone();
    },
  });
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void requestExit(t("impersonationChangesTheActiveAccount")).then((confirmed) => {
        if (confirmed) action.mutate((client) => client.impersonate(targetId));
        else onDone();
      });
    }
  }, [action, targetId, requestExit, onDone, t]);
  return null;
}
